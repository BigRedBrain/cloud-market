#!/usr/bin/env node
/**
 * ai-team.mjs — CloudMarket multi-agent coordinator (REVIEW-ONLY, v1).
 *
 * Runs two independent reviewers concurrently over the same task statement and
 * prints both answers side by side:
 *
 *   LANE 1 — GPT-5.6 Sol via @openai/agents, acting as architecture/security
 *            reviewer. No tools, so it cannot touch the filesystem.
 *   LANE 2 — Claude Code (`claude -p`, turn-limited), acting as an independent
 *            codebase reviewer under read-only instructions.
 *
 * This version deliberately does NOT: edit files, run migrations, reach a
 * database, call Neon, deploy, commit, push, or let either agent act on the
 * other's output. Both lanes produce recommendations for a human to judge.
 *
 * Usage:
 *   npm run ai:team -- "review the CloudMarket production migration drift"
 */

import {
  execFileSync,
  spawn,
} from 'node:child_process';

import {
  readFileSync,
} from 'node:fs';

import {
  join,
} from 'node:path';
import { Agent, run } from '@openai/agents';

const GPT_MODEL = 'gpt-5.6-sol';
const CLAUDE_MAX_TURNS =
  process.env
    .AI_TEAM_CLAUDE_MAX_TURNS
    ?.trim() ||
  '30';
const CLAUDE_TIMEOUT_MS = 600_000;
const GPT_SNAPSHOT_MAX_CHARS =
  140_000;

const GPT_FILE_MAX_CHARS =
  18_000;

const GPT_TREE_MAX_CHARS =
  35_000;
const REVIEW_REPO =
  process.env
    .AI_TEAM_REPO
    ?.trim() ||
  process.cwd();

/** The only tools the Claude reviewer may use — all read-only. */
const CLAUDE_TOOLS = 'Read,Glob,Grep';

/**
 * CLI-level hardening for the unattended Claude reviewer (Claude Code 2.1.239).
 * These are the enforcement counterpart to the read-only wording in the prompt:
 * even if the prompt were disregarded, Bash, Edit, and Write are not available.
 */
const CLAUDE_HARDENING_ARGS = [
  // Plan mode: analysis only, no mutating action taken.
  '--permission-mode',
  'plan',
  // Restrict the toolset to reads — no Bash, no Edit, no Write.
  '--tools',
  CLAUDE_TOOLS,
  // Ignore any ambient MCP server configuration; inherit no servers.
  '--strict-mcp-config',
  // Do not load project/user hooks, plugins, skills, or custom agents.
  '--safe-mode',
  // Leave no session state behind from an automated run.
  '--no-session-persistence',
  // No slash commands in an unattended context.
  '--disable-slash-commands',
  // No browser/Chrome integration.
  '--no-chrome',
];

/**
 * Environment variables never handed to the Claude child, by exact name.
 * The pattern list below catches the rest by shape.
 */
const CLAUDE_ENV_DENYLIST = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'NEON_API_KEY',
  'NEON_PROJECT_ID',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'INVITE_CODE_PEPPER',
  'CRON_SECRET',
  'BLOB_READ_WRITE_TOKEN',
];

/** Any variable whose NAME contains one of these (case-insensitive) is stripped. */
const CLAUDE_ENV_DENY_PATTERNS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'DATABASE_URL',
  'API_KEY',
];

const GPT_INSTRUCTIONS = `You are the CloudMarket architecture and security reviewer.

CloudMarket is a private, invite/application-gated multi-vendor marketplace:
Next.js on Vercel, PostgreSQL on Neon, Drizzle migrations, production branch
"main". Checkout, crypto payments, and auctions are feature-gated OFF.

You are reviewing only. You have no tools, but the coordinator provides a
bounded read-only snapshot of the actual CloudMarket repository.

Treat the supplied repository snapshot as the source of truth for
repository-specific findings.

Cite exact repository paths when the snapshot supports a finding.
Never invent a file, route, schema, migration, or implementation detail.
If the bounded snapshot does not contain enough evidence, say exactly what
still requires confirmation.

Focus on:
- correctness and safety risks, especially anything touching production data,
  migrations, roles and permissions, or the public/private boundary;
- what could go wrong and how it would be detected;
- the smallest safe next step, and what a human must verify first.

Do not propose commands that would mutate production. Be concrete and concise;
prefer a short ranked list of findings over prose. Flag your own uncertainty.`;

/** Build the read-only instruction envelope handed to Claude Code. */
function buildClaudePrompt(task) {
  return `You are an independent CloudMarket codebase reviewer working alongside a
separate reviewer whose output you cannot see. Review the task below against
the actual repository.

TASK:
${task}

STRICT CONSTRAINTS — this run is REVIEW-ONLY:
- You MAY read and inspect any repository files needed to answer.
- DO NOT edit, create, or delete any file.
- DO NOT run migrations or any drizzle-kit command.
- DO NOT connect to a database.
- DO NOT call Neon or any Neon API.
- DO NOT deploy, and DO NOT run any Vercel command.
- DO NOT commit, push, or modify main or any other branch.
- Return analysis and recommendations only.

If answering would require any forbidden action, say so and describe what you
would need instead. Report findings as a short ranked list, cite file paths and
line numbers where relevant, and state clearly what you verified in the code
versus what remains an assumption.`;
}

/** Read the task from CLI arguments; throws if empty. */
function readTask() {
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) {
    throw new Error(
      'A task is required.\n' +
        '  Usage: npm run ai:team -- "review the CloudMarket production migration drift"',
    );
  }
  return task;
}

/**
 * Build the Claude child environment: process.env minus every denylisted or
 * suspicious-by-name variable. Returns the sanitized env plus the NAMES that
 * were removed — never the values.
 */
function buildClaudeEnv() {
  const denySet = new Set(CLAUDE_ENV_DENYLIST.map((name) => name.toUpperCase()));
  const claudeEnv = {};
  const stripped = [];

  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    const isDenied =
      denySet.has(upper) ||
      CLAUDE_ENV_DENY_PATTERNS.some((pattern) => upper.includes(pattern));

    if (isDenied) {
      stripped.push(name);
      continue;
    }
    claudeEnv[name] = value;
  }

  return { claudeEnv, stripped: stripped.sort() };
}

/**
 * Resolve the Claude Code executable.
 *
 * On Windows we point at the native binary from the npm global install rather
 * than the `claude.cmd` shim, so the child can be spawned directly with no
 * shell involved. Elsewhere we rely on `claude` being on PATH.
 */
function resolveClaudeCommand() {
  if (process.platform !== 'win32') {
    return 'claude';
  }

  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('APPDATA is not set; cannot locate claude.exe on Windows');
  }

  return join(
    appData,
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
}
function shouldSnapshotFile(
  filePath,
) {
  const lower =
    filePath.toLowerCase();

  if (
    lower === '.env' ||
    (
      lower.startsWith('.env.') &&
      lower !== '.env.example'
    )
  ) {
    return false;
  }

  if (
    lower === 'package-lock.json' ||
    lower === 'pnpm-lock.yaml' ||
    lower === 'yarn.lock'
  ) {
    return false;
  }

  if (
    lower.startsWith(
      'drizzle/meta/',
    )
  ) {
    return false;
  }

  if (
    /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp4|mov|avi|mp3)$/i
      .test(filePath)
  ) {
    return false;
  }

  return (
    /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|css|scss|yml|yaml|toml)$/i
      .test(filePath)
  );
}

function snapshotPriority(
  filePath,
) {
  const lower =
    filePath.toLowerCase();

  if (
    lower === 'proxy.ts' ||
    lower === 'middleware.ts' ||
    lower.includes('/auth/') ||
    lower.includes('/security/') ||
    lower.includes('/schema/') ||
    lower.includes('permission') ||
    lower.includes('invite') ||
    lower.includes('marketplace') ||
    lower.includes('admin')
  ) {
    return 0;
  }

  if (
    lower.startsWith('app/') ||
    lower.startsWith('lib/') ||
    lower.startsWith('drizzle/')
  ) {
    return 1;
  }

  if (
    lower.startsWith('components/') ||
    lower.startsWith('scripts/') ||
    lower.endsWith('.md')
  ) {
    return 2;
  }

  return 3;
}
function buildGptRepositorySnapshot() {
  const tracked =
    execFileSync(
      'git',
      [
        'ls-files',
        '-z',
      ],
      {
        cwd:
          REVIEW_REPO,

        encoding:
          'utf8',

        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],

        maxBuffer:
          10 * 1024 * 1024,
      },
    );

  const files =
    tracked
      .split('\0')
      .filter(Boolean)
      .filter(
        shouldSnapshotFile,
      )
      .sort(
        (
          left,
          right,
        ) => {
          const priorityDiff =
            snapshotPriority(left) -
            snapshotPriority(right);

          if (
            priorityDiff !== 0
          ) {
            return priorityDiff;
          }

          return left.localeCompare(
            right,
          );
        },
      );

  const fullTree =
    files.join('\n');

  const tree =
    fullTree.length >
    GPT_TREE_MAX_CHARS
      ? `${
          fullTree.slice(
            0,
            GPT_TREE_MAX_CHARS,
          )
        }\n...[file tree truncated]`
      : fullTree;

  const sections = [
    [
      'CLOUDMARKET READ-ONLY REPOSITORY SNAPSHOT',
      `Target: ${REVIEW_REPO}`,
      '',
      'TRACKED TEXT FILE TREE:',
      tree,
    ].join('\n'),
  ];

  let used =
    sections[0].length;

  for (
    const filePath
    of files
  ) {
    let text;

    try {
      text =
        readFileSync(
          join(
            REVIEW_REPO,
            filePath,
          ),
          'utf8',
        );
    } catch {
      continue;
    }

    if (
      text.includes('\0')
    ) {
      continue;
    }

    if (
      text.length >
      GPT_FILE_MAX_CHARS
    ) {
      text =
        `${
          text.slice(
            0,
            GPT_FILE_MAX_CHARS,
          )
        }\n...[file truncated]`;
    }

    const block =
      [
        `===== FILE: ${filePath} =====`,
        text,
      ].join('\n');

    if (
      used +
        block.length >
      GPT_SNAPSHOT_MAX_CHARS
    ) {
      continue;
    }

    sections.push(
      block,
    );

    used +=
      block.length;
  }

  return sections.join(
    '\n\n',
  );
}
/** LANE 1 — GPT reviewer. No tools, so it cannot modify anything. */
async function runGptLane(task) {
  if (
    !process.env.OPENAI_API_KEY
  ) {
    throw new Error(
      'OPENAI_API_KEY is not set in this environment; the GPT lane cannot run.',
    );
  }

  const repositorySnapshot =
    buildGptRepositorySnapshot();

  const agent =
    new Agent({
      name:
        'CloudMarket GPT Reviewer',
      model:
        GPT_MODEL,
      instructions:
        GPT_INSTRUCTIONS,
      tools: [],
    });

  const result =
    await run(
      agent,
      [
        'TASK:',
        task,
        '',
        repositorySnapshot,
      ].join('\n'),
    );

  const output =
    (result.finalOutput ?? '')
      .toString()
      .trim();

  return (
    output ||
    '(GPT returned no text output.)'
  );
}

/** LANE 2 — Claude Code reviewer, non-interactive and turn-limited. */
function runClaudeLane(task, claudeEnv) {
  const command = resolveClaudeCommand();
  const args = [
    '-p',
    buildClaudePrompt(task),
    '--max-turns',
    CLAUDE_MAX_TURNS,
    ...CLAUDE_HARDENING_ARGS,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: claudeEnv,
      cwd: REVIEW_REPO,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(
        reject,
        new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS}ms with no result.`),
      );
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(reject, new Error(`Failed to launch "${command}": ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        const output = stdout.trim();
        finish(resolve, output || '(Claude returned no text output.)');
        return;
      }
        const stderrDetail =
        stderr
          .trim()
          .split(/\r?\n/)
          .slice(-30)
          .join('\n');

      const stdoutDetail =
        stdout
          .trim()
          .split(/\r?\n/)
          .slice(-30)
          .join('\n');

      finish(
        reject,
        new Error(
          [
            `Claude exited with code ${code}.`,
            '',
            'STDERR:',
            stderrDetail ||
              '(no stderr output)',
            '',
            'STDOUT:',
            stdoutDetail ||
              '(no stdout output)',
          ].join('\n'),
        ),
      );
    });
  });
}

/** Wrap a lane so it always settles, letting both run to completion. */
function settle(label, promise) {
  return Promise.resolve(promise).then(
    (output) => ({ label, ok: true, output }),
    (error) => ({ label, ok: false, error }),
  );
}

function banner(title) {
  const width = 44;
  const padded = ` ${title} `;
  const fill = Math.max(0, width - padded.length);
  const left = '='.repeat(Math.floor(fill / 2));
  const right = '='.repeat(Math.ceil(fill / 2));
  return `${left}${padded}${right}`;
}

function printLane(title, result) {
  console.log(banner(title));
  console.log('');
  if (result.ok) {
    console.log(result.output);
  } else {
    console.log(`LANE FAILED: ${result.error.message}`);
  }
  console.log('');
}

async function main() {
  const task = readTask();
  const { claudeEnv, stripped } = buildClaudeEnv();

  console.log('CloudMarket AI team — review only. No writes, migrations, or deploys.');
  console.log(`Task: ${task}`);
  console.log(
    `Review target: ${REVIEW_REPO}`,
  );
    console.log(
    `Lane 1: @openai/agents (${GPT_MODEL}) — bounded read-only repository snapshot`,
  );
  console.log(
    `Lane 2: claude -p --max-turns ${CLAUDE_MAX_TURNS} — plan/read-only mode, ` +
      `tools limited to ${CLAUDE_TOOLS}, no MCP, no hooks/plugins/skills, no Chrome`,
  );
  console.log(
    `Stripped from Claude's environment (${stripped.length}): ` +
      (stripped.length ? stripped.join(', ') : '(none)'),
  );
  console.log('');
  console.log('Both lanes running...');
  console.log('');

  const [gptResult, claudeResult] = await Promise.all([
    settle('GPT', runGptLane(task)),
    settle('CLAUDE', runClaudeLane(task, claudeEnv)),
  ]);

  printLane('GPT REVIEW', gptResult);
  printLane('CLAUDE REVIEW', claudeResult);

  console.log(banner('TEAM STATUS'));
  console.log('');

  const failures = [gptResult, claudeResult].filter((result) => !result.ok);
  if (failures.length === 0) {
    console.log('Both agents completed independently.');
  } else {
    for (const failure of failures) {
      console.log(`${failure.label} lane FAILED: ${failure.error.message}`);
    }
    console.log(
      `${2 - failures.length} of 2 lanes completed. Treat this review as incomplete.`,
    );
  }

  console.log('');
  console.log('HUMAN REVIEW REQUIRED BEFORE ANY WRITE / MIGRATION / DEPLOYMENT ACTION.');

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`ai-team failed: ${err.message}`);
  process.exitCode = 1;
});
