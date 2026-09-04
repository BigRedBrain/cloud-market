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
  320_000;

const GPT_FILE_MAX_CHARS =
  18_000;

const GPT_TASK_FILE_MAX_CHARS =
  180_000;

const GPT_TREE_MAX_CHARS =
  35_000;

const GPT_OMISSION_SUMMARY_MAX_CHARS =
  8_000;

const GPT_SNAPSHOT_GIT_ARGS = [
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
];
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

const REVIEW_APPROVE_VERDICT = 'APPROVE FOR HUMAN INTEGRATION REVIEW';
const REVIEW_BLOCK_VERDICT = 'BLOCK INTEGRATION';

const REVIEW_VERDICTS = Object.freeze([
  REVIEW_APPROVE_VERDICT,
  REVIEW_BLOCK_VERDICT,
]);

function countReviewVerdictToken(text, token) {
  let count = 0;
  let index = 0;

  while ((index = text.indexOf(token, index)) !== -1) {
    count += 1;
    index += token.length;
  }

  return count;
}

function parseReviewVerdict(output) {
  if (typeof output !== 'string' || output.trim().length === 0) {
    return { ok: false, reason: 'review returned no text' };
  }

  const text = output.trim();
  const finalLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";

  const occurrences = REVIEW_VERDICTS.reduce(
    (total, verdict) => total + countReviewVerdictToken(text, verdict),
    0,
  );

  if (occurrences !== 1) {
    return {
      ok: false,
      reason: 'review must contain exactly one recognized verdict token',
    };
  }

  if (!REVIEW_VERDICTS.includes(finalLine)) {
    return {
      ok: false,
      reason: 'final non-empty line is not an exact recognized verdict',
    };
  }

  return { ok: true, verdict: finalLine };
}

function requireReviewVerdict(label, output) {
  const parsed = parseReviewVerdict(output);

  if (!parsed.ok) {
    throw new Error(
      label + ' review verdict invalid: ' + parsed.reason,
    );
  }

  return parsed.verdict;
}

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
prefer a short ranked list of findings over prose. Flag your own uncertainty.

Before reviewing, compare every path under TASK-REFERENCED FILES (required)
with the exact [TASK-CRITICAL] file blocks in the supplied snapshot. The
snapshot builder fails closed if a required file cannot be embedded. Do not
substitute unrelated findings for the requested task scope.

Your final non-empty line MUST be exactly one of these two verdicts:
APPROVE FOR HUMAN INTEGRATION REVIEW
BLOCK INTEGRATION
Emit exactly one of those verdict tokens in the entire response.`;

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
versus what remains an assumption.

Your final non-empty line MUST be exactly one of these two verdicts:
APPROVE FOR HUMAN INTEGRATION REVIEW
BLOCK INTEGRATION
Emit exactly one of those verdict tokens in the entire response.`;
}

const CLI_USAGE = [
  'Usage:',
  '  npm run ai:team -- "<review task>"',
  '  npm run ai:team -- --help',
  '  npm run ai:team -- --self-test',
  '',
  'The review task must be exactly one quoted positional argument.',
].join('\n');

function parseCli(argv) {
  if (
    argv.length === 1 &&
    (argv[0] === '--help' || argv[0] === '-h')
  ) {
    return { mode: 'help' };
  }

  if (
    argv.length === 1 &&
    argv[0] === '--self-test'
  ) {
    return { mode: 'self-test' };
  }

  const option =
    argv.find(
      (value) => value.startsWith('-'),
    );

  if (option) {
    throw new Error(
      `Unknown option: ${option}\n\n${CLI_USAGE}`,
    );
  }

  if (argv.length !== 1) {
    throw new Error(
      `Exactly one quoted review task is required.\n\n${CLI_USAGE}`,
    );
  }

  const task = argv[0].trim();

  if (!task) {
    throw new Error(
      `The review task cannot be empty.\n\n${CLI_USAGE}`,
    );
  }

  return { mode: 'review', task };
}

function runSelfTest() {
  let failures = 0;

  const check = (label, condition) => {
    if (condition) {
      console.log(`PASS  ${label}`);
      return;
    }

    failures += 1;
    console.log(`FAIL  ${label}`);
  };

  check(
    '--help is control flow',
    parseCli(['--help']).mode === 'help',
  );

  check(
    '--self-test is control flow',
    parseCli(['--self-test']).mode === 'self-test',
  );

  check(
    'one quoted task is accepted',
    parseCli(['review marketplace safety']).mode === 'review',
  );

  let unknownRefused = false;

  try {
    parseCli(['--hlep']);
  } catch {
    unknownRefused = true;
  }

  check(
    'unknown options are refused',
    unknownRefused,
  );

  let multipleRefused = false;

  try {
    parseCli(['first', 'second']);
  } catch {
    multipleRefused = true;
  }

  check(
    'multiple positional arguments are refused',
    multipleRefused,
  );

  console.log('');
  console.log(
    `AI TEAM CLI SELF-TEST: ${5 - failures} passed, ${failures} failed`,
  );

  if (failures > 0) {
    throw new Error('AI team CLI self-test failed.');
  }
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

function normalizeTaskPathText(value) {
  return String(value)
    .replace(/\\/g, '/')
    .toLowerCase();
}

function normalizeRepoRelativePath(value) {
  let normalized =
    normalizeTaskPathText(value)
      .trim();

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//.test(normalized)
  ) {
    return null;
  }

  const parts = normalized.split('/');

  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..',
    )
  ) {
    return null;
  }

  return parts.join('/');
}

/**
 * Extract source-looking repository-relative paths explicitly written in the
 * review task. Backslashes are normalised first so Windows tasks behave the
 * same way as repository paths from Git.
 */
function extractExplicitTaskPaths(task) {
  const text =
    normalizeTaskPathText(task)
      .replace(/\x60/g, ' ');

  const pattern =
    /(?:^|[\s"'(\[{,:])((?:\.\/)?(?:[a-z0-9_.@\-\[\]]+\/)*[a-z0-9_.@\-\[\]]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|css|scss|yml|yaml|toml))(?=$|[\s"',;:)])/g;

  const found =
    new Set();

  for (const match of text.matchAll(pattern)) {
    const normalized =
      normalizeRepoRelativePath(match[1]);

    if (normalized !== null) {
      found.add(normalized);
    }
  }

  return [...found];
}

function taskMentionsFile(
  task,
  filePath,
) {
  const relative =
    normalizeRepoRelativePath(filePath);

  if (relative === null) {
    return false;
  }

  const taskText =
    normalizeTaskPathText(task);

  const absolute =
    normalizeTaskPathText(
      join(
        REVIEW_REPO,
        filePath,
      ),
    );

  return (
    taskText.includes(relative) ||
    taskText.includes(absolute)
  );
}

/**
 * Resolve task-critical files before any snapshot budgeting occurs.
 *
 * A path in a known repository directory that the task explicitly names but
 * Git cannot expose is a hard failure. A task-critical file rejected by the
 * existing safety filter is also a hard failure rather than a reason to weaken
 * that filter.
 */
function resolveTaskMentionedFiles(
  task,
  discoveredFiles,
) {
  const byNormalized =
    new Map();

  const repositoryRoots =
    new Set();

  for (const filePath of discoveredFiles) {
    const normalized =
      normalizeRepoRelativePath(filePath);

    if (normalized === null) {
      continue;
    }

    byNormalized.set(
      normalized,
      filePath,
    );

    repositoryRoots.add(
      normalized.split('/')[0],
    );
  }

  const mentioned =
    new Set();

  for (
    const candidate
    of extractExplicitTaskPaths(task)
  ) {
    const filePath =
      byNormalized.get(candidate);

    if (filePath !== undefined) {
      mentioned.add(filePath);
      continue;
    }

    const firstSegment =
      candidate.split('/')[0];

    if (
      repositoryRoots.has(firstSegment)
    ) {
      throw new Error(
        'The review task explicitly names a repository source file that Git did not expose: ' +
          candidate,
      );
    }
  }

  for (const filePath of discoveredFiles) {
    if (
      taskMentionsFile(
        task,
        filePath,
      )
    ) {
      mentioned.add(filePath);
    }
  }

  for (const filePath of mentioned) {
    if (!shouldSnapshotFile(filePath)) {
      throw new Error(
        'The review task explicitly names a file excluded by the snapshot safety policy: ' +
          filePath,
      );
    }
  }

  return mentioned;
}

function truncateSnapshotText(
  text,
  maxChars,
  preserveTail,
) {
  if (text.length <= maxChars) {
    return text;
  }

  const marker =
    '\n...[file truncated; original chars: ' +
    text.length +
    ']...\n';

  const room =
    maxChars - marker.length;

  if (room <= 0) {
    throw new Error(
      'Snapshot file limit is too small to hold its truncation marker.',
    );
  }

  if (!preserveTail) {
    return (
      text.slice(0, room) +
      marker
    );
  }

  const headChars =
    Math.ceil(room / 2);

  const tailChars =
    Math.floor(room / 2);

  return (
    text.slice(0, headChars) +
    marker +
    text.slice(
      text.length - tailChars,
    )
  );
}

function snapshotPriority(
  filePath,
  taskFiles = new Set(),
) {
  if (taskFiles.has(filePath)) {
    return -1;
  }

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

function selectSnapshotFiles(
  discoveredFiles,
  taskFiles = new Set(),
) {
  const candidates =
    discoveredFiles.filter(
      shouldSnapshotFile,
    );

  const scoped =
    taskFiles.size > 0
      ? candidates.filter(
          (filePath) =>
            taskFiles.has(filePath),
        )
      : candidates;

  return scoped.sort(
    (
      left,
      right,
    ) => {
      const priorityDiff =
        snapshotPriority(
          left,
          taskFiles,
        ) -
        snapshotPriority(
          right,
          taskFiles,
        );

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
}

function buildGptRepositorySnapshot(
  task,
) {
  if (
    typeof task !== 'string' ||
    task.trim().length === 0
  ) {
    throw new Error(
      'A non-empty review task is required to build the GPT snapshot.',
    );
  }

  const listed =
    execFileSync(
      'git',
      GPT_SNAPSHOT_GIT_ARGS,
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

  const discoveredFiles =
    [
      ...new Set(
        listed
          .split('\0')
          .filter(Boolean),
      ),
    ];

  const taskFiles =
    resolveTaskMentionedFiles(
      task,
      discoveredFiles,
    );

  const files =
    selectSnapshotFiles(
      discoveredFiles,
      taskFiles,
    );

  const fullTree =
    files.join('\n');

  const tree =
    fullTree.length >
    GPT_TREE_MAX_CHARS
      ? (
          fullTree.slice(
            0,
            GPT_TREE_MAX_CHARS,
          ) +
          '\n...[file tree truncated]'
        )
      : fullTree;

  const requiredFiles =
    [...taskFiles]
      .sort(
        (left, right) =>
          left.localeCompare(right),
      );

  const sections = [
    [
      'CLOUDMARKET READ-ONLY REPOSITORY SNAPSHOT',
      'Target: ' + REVIEW_REPO,
      '',
      'TASK-REFERENCED FILES (required):',
      requiredFiles.length > 0
        ? requiredFiles.join('\n')
        : '(none detected)',
      '',
      'Every required path above must have an exact [TASK-CRITICAL] content block',
      'later in this snapshot. Construction fails closed if any required block',
      'cannot be included.',
      '',
      'TRACKED + UNTRACKED REVIEWABLE TEXT FILE TREE:',
      tree,
      '',
      'Safety-excluded files are intentionally absent. A task that explicitly',
      'requires one fails closed instead of weakening the exclusion policy.',
    ].join('\n'),
  ];

  const contentLimit =
    GPT_SNAPSHOT_MAX_CHARS -
    GPT_OMISSION_SUMMARY_MAX_CHARS;

  let used =
    sections[0].length;

  if (used > contentLimit) {
    throw new Error(
      'Snapshot metadata alone exceeds the bounded snapshot budget.',
    );
  }

  const includedTaskFiles =
    new Set();

  const omitted =
    [];

  for (const filePath of files) {
    const required =
      taskFiles.has(filePath);

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
    } catch (error) {
      if (required) {
        throw new Error(
          'Task-critical file could not be read: ' +
            filePath +
            ' (' +
            (
              error instanceof Error
                ? error.message
                : String(error)
            ) +
            ')',
        );
      }

      omitted.push(
        filePath +
          ' [read-error]',
      );

      continue;
    }

    if (text.includes('\0')) {
      if (required) {
        throw new Error(
          'Task-critical file was binary or contained NUL bytes: ' +
            filePath,
        );
      }

      omitted.push(
        filePath +
          ' [binary/NUL]',
      );

      continue;
    }

    const fileLimit =
      required
        ? GPT_TASK_FILE_MAX_CHARS
        : GPT_FILE_MAX_CHARS;

    text =
      truncateSnapshotText(
        text,
        fileLimit,
        required,
      );

    const block =
      [
        '===== FILE: ' +
          filePath +
          (
            required
              ? ' [TASK-CRITICAL] ====='
              : ' ====='
          ),
        text,
      ].join('\n');

    const sectionCost =
      2 + block.length;

    if (
      used +
        sectionCost >
      contentLimit
    ) {
      if (required) {
        throw new Error(
          'Task-critical files cannot fit inside the bounded GPT snapshot. Refusing an incomplete review. File: ' +
            filePath,
        );
      }

      omitted.push(
        filePath +
          ' [snapshot-budget]',
      );

      continue;
    }

    sections.push(block);

    used +=
      sectionCost;

    if (required) {
      includedTaskFiles.add(
        filePath,
      );
    }
  }

  const missingRequired =
    requiredFiles.filter(
      (filePath) =>
        !includedTaskFiles.has(
          filePath,
        ),
    );

  if (missingRequired.length > 0) {
    throw new Error(
      'Task-critical files were not included in the GPT snapshot: ' +
        missingRequired.join(', '),
    );
  }

  let omissionSummary =
    [
      'SNAPSHOT OMISSIONS (non-task files only):',
      omitted.length === 0
        ? '(none)'
        : (
            'Count: ' +
            omitted.length +
            '\n' +
            omitted.join('\n')
          ),
    ].join('\n');

  omissionSummary =
    truncateSnapshotText(
      omissionSummary,
      GPT_OMISSION_SUMMARY_MAX_CHARS,
      false,
    );

  sections.push(
    omissionSummary,
  );

  const snapshot =
    sections.join('\n\n');

  if (
    snapshot.length >
    GPT_SNAPSHOT_MAX_CHARS
  ) {
    throw new Error(
      'Internal snapshot accounting exceeded the configured GPT snapshot bound.',
    );
  }

  return snapshot;
}

/**
 * Pure/offline snapshot safety tests. No reviewer lane, network request, file
 * mutation, or database operation occurs here.
 */
function runSnapshotSelfTest() {
  const failures =
    [];

  const check =
    (
      condition,
      label,
    ) => {
      if (!condition) {
        failures.push(label);
      }
    };

  check(
    GPT_SNAPSHOT_GIT_ARGS.join('|') ===
      'ls-files|-z|--cached|--others|--exclude-standard',
    'Git discovery includes cached + untracked and still respects ignore rules',
  );

  check(
    taskMentionsFile(
      'Review scripts\\new-file.ts carefully',
      'scripts/new-file.ts',
    ),
    'Windows task paths match repository paths',
  );

  check(
    taskMentionsFile(
      'Review SCRIPTS/NEW-FILE.TS carefully',
      'scripts/new-file.ts',
    ),
    'task path matching is case-normalised',
  );

  const syntheticFiles = [
    'lib/example.ts',
    'scripts/new-file.ts',
  ];

  const required =
    resolveTaskMentionedFiles(
      'Review scripts\\new-file.ts',
      syntheticFiles,
    );

  check(
    required.size === 1 &&
      required.has(
        'scripts/new-file.ts',
      ),
    'explicit task file is marked task-critical',
  );

  let missingRefused =
    false;

  try {
    resolveTaskMentionedFiles(
      'Review scripts/missing-file.ts',
      syntheticFiles,
    );
  } catch {
    missingRefused =
      true;
  }

  check(
    missingRefused,
    'a named missing source file fails closed',
  );

  let excludedRefused =
    false;

  try {
    resolveTaskMentionedFiles(
      'Review .env',
      ['.env'],
    );
  } catch {
    excludedRefused =
      true;
  }

  check(
    excludedRefused,
    'a task cannot override the existing snapshot safety exclusion',
  );

  const truncated =
    truncateSnapshotText(
      'A'.repeat(250) +
        'TAIL',
      100,
      true,
    );

  check(
    truncated.length <= 100 &&
      truncated.includes(
        '[file truncated;',
      ) &&
      truncated.endsWith(
        'TAIL',
      ),
    'task-critical truncation preserves both head and tail inside its bound',
  );

  check(
    GPT_TASK_FILE_MAX_CHARS >
      GPT_FILE_MAX_CHARS &&
      GPT_SNAPSHOT_MAX_CHARS >
        GPT_TASK_FILE_MAX_CHARS,
    'task-critical files receive a larger but still bounded allowance',
  );

  const slice2bFiles = [
    'lib/marketplace/membership-grant-apply.ts',
    'scripts/apply-marketplace-memberships.ts',
    'scripts/verify-marketplace-membership-apply.ts',
  ];

  const slice2bRequired = resolveTaskMentionedFiles(
    [
      'Review these exact files:',
      'lib/marketplace/membership-grant-apply.ts',
      'scripts/apply-marketplace-memberships.ts',
      'scripts/verify-marketplace-membership-apply.ts',
    ].join(' '),
    slice2bFiles,
  );

  check(
    slice2bRequired.size === 3 &&
      slice2bFiles.every((filePath) => slice2bRequired.has(filePath)),
    'multiple explicit task files are all marked task-critical',
  );

  const slice2bSelection =
    selectSnapshotFiles(
      [
        ...slice2bFiles,
        'lib/auth/dal.ts',
        'proxy.ts',
      ],
      slice2bRequired,
    );

  check(
    slice2bSelection.length === 3 &&
      slice2bFiles.every(
        (filePath) =>
          slice2bSelection.includes(filePath),
      ) &&
      !slice2bSelection.includes(
        'lib/auth/dal.ts',
      ) &&
      !slice2bSelection.includes(
        'proxy.ts',
      ),
    'explicit task files restrict GPT snapshot to task-critical files only',
  );

  const broadSelection =
    selectSnapshotFiles(
      [
        ...slice2bFiles,
        'lib/auth/dal.ts',
        'proxy.ts',
      ],
      new Set(),
    );

  check(
    broadSelection.length === 5 &&
      broadSelection.includes(
        'lib/auth/dal.ts',
      ) &&
      broadSelection.includes(
        'proxy.ts',
      ),
    'tasks without explicit files retain broad GPT snapshot behavior',
  );

  check(
    parseReviewVerdict('finding\nAPPROVE FOR HUMAN INTEGRATION REVIEW').ok,
    'an exact terminal approval verdict is accepted',
  );

  check(
    parseReviewVerdict('finding\nBLOCK INTEGRATION').ok,
    'an exact terminal block verdict is accepted',
  );

  check(
    !parseReviewVerdict('finding only').ok,
    'missing reviewer verdict fails closed',
  );

  check(
    !parseReviewVerdict(
      'APPROVE FOR HUMAN INTEGRATION REVIEW\nAPPROVE FOR HUMAN INTEGRATION REVIEW',
    ).ok,
    'duplicate reviewer verdict fails closed',
  );

  check(
    !parseReviewVerdict(
      'APPROVE FOR HUMAN INTEGRATION REVIEW\nBLOCK INTEGRATION',
    ).ok,
    'conflicting reviewer verdicts fail closed',
  );

  check(
    !parseReviewVerdict(
      'APPROVE FOR HUMAN INTEGRATION REVIEW\nextra prose',
    ).ok,
    'a non-terminal reviewer verdict fails closed',
  );

  check(
    GPT_INSTRUCTIONS.includes('Your final non-empty line MUST be exactly'),
    'GPT prompt requires a terminal machine-checkable verdict',
  );

  check(
    buildClaudePrompt('self-test').includes(
      'Your final non-empty line MUST be exactly',
    ),
    'Claude prompt requires a terminal machine-checkable verdict',
  );

  if (failures.length > 0) {
    throw new Error(
      'Snapshot self-test failed: ' +
        failures.join('; '),
    );
  }

  console.log(
    'SNAPSHOT SELF-TEST OK',
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
    buildGptRepositorySnapshot(task);

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
    (output) => {
      const verdict = requireReviewVerdict(label, output);
      return { label, ok: true, output, verdict };
    },
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
  const cli = parseCli(process.argv.slice(2));

  if (cli.mode === 'help') {
    console.log(CLI_USAGE);
    return;
  }

  if (cli.mode === 'self-test') {
    runSelfTest();
    runSnapshotSelfTest();
    return;
  }

  const task = cli.task;
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
  const blockers = [gptResult, claudeResult].filter(
    (result) =>
      result.ok &&
      result.verdict === REVIEW_BLOCK_VERDICT,
  );
  if (failures.length === 0) {
    console.log('Both agents completed independently with valid terminal verdicts.');
  } else {
    for (const failure of failures) {
      console.log(`${failure.label} lane FAILED: ${failure.error.message}`);
    }
    console.log(
      `${2 - failures.length} of 2 lanes completed. Treat this review as incomplete.`,
    );
  }

  console.log('');
  if (blockers.length > 0) {
    console.log(
      'INTEGRATION BLOCKED BY REVIEWER VERDICT: ' +
        blockers.map((result) => result.label).join(', '),
    );
    console.log("");
  }

  console.log('HUMAN REVIEW REQUIRED BEFORE ANY WRITE / MIGRATION / DEPLOYMENT ACTION.');

  if (failures.length > 0 || blockers.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`ai-team failed: ${err.message}`);
  process.exitCode = 1;
});
