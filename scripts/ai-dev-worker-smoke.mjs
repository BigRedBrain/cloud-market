#!/usr/bin/env node

/**
 * CloudMarket AI Development Team
 * Parallel Claude Worker Smoke Test
 *
 * PURPOSE:
 * Prove that three isolated Claude coding workers can run simultaneously,
 * each inside its own Git worktree, while remaining tightly constrained.
 *
 * Each worker may create exactly ONE harmless smoke-test file.
 *
 * This script DOES NOT:
 * - run Bash through Claude
 * - commit
 * - push
 * - merge
 * - deploy
 * - access databases
 * - run migrations
 * - modify production configuration
 */

import {
  execFileSync,
  spawn,
} from 'node:child_process';

import {
  existsSync,
  readFileSync,
} from 'node:fs';

import {
  dirname,
  join,
  resolve,
} from 'node:path';

import {
  fileURLToPath,
} from 'node:url';

const BASE_REF =
  process.env.AI_DEV_BASE_REF?.trim() ||
  'origin/main';

const CLAUDE_MAX_TURNS = '4';

const CLAUDE_TIMEOUT_MS =
  180_000;

const WORKERS = [
  {
    role: 'frontend',
    smokeFile:
      'AI_FRONTEND_WORKER_SMOKE.txt',
  },
  {
    role: 'backend',
    smokeFile:
      'AI_BACKEND_WORKER_SMOKE.txt',
  },
  {
    role: 'database',
    smokeFile:
      'AI_DATABASE_WORKER_SMOKE.txt',
  },
];

const ENV_DENYLIST = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'ANTHROPIC_API_KEY',
  'NEON_API_KEY',
  'NEON_PROJECT_ID',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'AUTH_SECRET',
  'INVITE_CODE_PEPPER',
  'CRON_SECRET',
  'BLOB_READ_WRITE_TOKEN',
  'RESEND_API_KEY',
];

const ENV_DENY_PATTERNS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'DATABASE_URL',
  'API_KEY',
];

function git(
  args,
  cwd,
  stdio = [
    'ignore',
    'pipe',
    'pipe',
  ],
) {
  return execFileSync(
    'git',
    args,
    {
      cwd,
      encoding: 'utf8',
      stdio,
    },
  ).trim();
}

function getRepoRoot() {
  return resolve(
    git(
      [
        'rev-parse',
        '--show-toplevel',
      ],
      process.cwd(),
    ),
  );
}

function requireCleanRepo(
  repoRoot,
) {
  const status =
    git(
      [
        'status',
        '--porcelain',
      ],
      repoRoot,
    );

  if (status) {
    throw new Error(
      'Working tree is not clean.\n\n' +
      status,
    );
  }
}

function requireSafeBranch(
  repoRoot,
) {
  const branch =
    git(
      [
        'branch',
        '--show-current',
      ],
      repoRoot,
    );

  if (!branch) {
    throw new Error(
      'Detached HEAD detected.',
    );
  }

  if (
    branch === 'main' ||
    branch === 'master'
  ) {
    throw new Error(
      `Refusing to launch workers from protected branch "${branch}".`,
    );
  }

  return branch;
}

function requireBaseRef(
  repoRoot,
) {
  try {
    git(
      [
        'rev-parse',
        '--verify',
        BASE_REF,
      ],
      repoRoot,
    );
  } catch {
    throw new Error(
      `Base ref "${BASE_REF}" was not found. Run git fetch origin first.`,
    );
  }
}

function makeSessionId() {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:T]/g, '')
    .slice(0, 14);
}

function resolveClaudeCommand() {
  if (
    process.platform !== 'win32'
  ) {
    return 'claude';
  }

  const appData =
    process.env.APPDATA;

  if (!appData) {
    throw new Error(
      'APPDATA is not set; cannot locate Claude Code.',
    );
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

function buildClaudeEnv() {
  const denySet =
    new Set(
      ENV_DENYLIST.map(
        (name) =>
          name.toUpperCase(),
      ),
    );

  const env = {};
  const stripped = [];

  for (
    const [name, value]
    of Object.entries(
      process.env,
    )
  ) {
    const upper =
      name.toUpperCase();

    const denied =
      denySet.has(upper) ||
      ENV_DENY_PATTERNS.some(
        (pattern) =>
          upper.includes(
            pattern,
          ),
      );

    if (denied) {
      stripped.push(name);
      continue;
    }

    env[name] = value;
  }

  return {
    env,
    stripped:
      stripped.sort(),
  };
}

function createDefinitions(
  repoRoot,
  sessionId,
) {
  const root =
    join(
      dirname(repoRoot),
      'cloudmarket-ai-worktrees',
      `worker-smoke-${sessionId}`,
    );

  return {
    root,

    workers:
      WORKERS.map(
        (worker) => ({
          ...worker,

          branch:
            `ai/worker-smoke-${sessionId}-${worker.role}`,

          path:
            join(
              root,
              worker.role,
            ),
        }),
      ),
  };
}

function branchExists(
  repoRoot,
  branch,
) {
  return Boolean(
    git(
      [
        'branch',
        '--list',
        branch,
      ],
      repoRoot,
    ),
  );
}

function preflightWorkers(
  repoRoot,
  workers,
) {
  for (
    const worker
    of workers
  ) {
    if (
      branchExists(
        repoRoot,
        worker.branch,
      )
    ) {
      throw new Error(
        `Branch already exists: ${worker.branch}`,
      );
    }

    if (
      existsSync(
        worker.path,
      )
    ) {
      throw new Error(
        `Worktree already exists: ${worker.path}`,
      );
    }
  }
}

function createWorktree(
  repoRoot,
  worker,
) {
  console.log(
    `Creating ${worker.role} worktree...`,
  );

  execFileSync(
    'git',
    [
      'worktree',
      'add',
      '-b',
      worker.branch,
      worker.path,
      BASE_REF,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );
}

function expectedContent(
  worker,
) {
  return (
    `CLOUDMARKET ${worker.role.toUpperCase()} WORKER OK`
  );
}

function buildPrompt(
  worker,
) {
  return `
You are the CloudMarket ${worker.role} worker.

This is ONLY a harmless parallel-worker connectivity and write-isolation test.

YOUR ONE AND ONLY TASK:

Create exactly this repository-root file:

${worker.smokeFile}

The complete file contents must be exactly:

${expectedContent(worker)}

STRICT RULES:

- You may read repository files if needed.
- Create or modify ONLY ${worker.smokeFile}.
- Do not modify any other file.
- Do not create any other file.
- Do not use Bash.
- Do not run tests.
- Do not run npm.
- Do not use Git.
- Do not commit.
- Do not push.
- Do not access any database.
- Do not inspect environment variables.
- Do not access secrets.
- Do not deploy.
- Do not use Vercel.
- Do not use external services.

After creating the file, verify its contents using Read.

Then reply exactly:

${worker.role.toUpperCase()} WORKER SMOKE COMPLETE
`.trim();
}

function buildClaudeArgs(
  worker,
) {
  return [
    '-p',
    buildPrompt(worker),

    '--max-turns',
    CLAUDE_MAX_TURNS,

    '--permission-mode',
    'default',

    '--tools',
    'Read,Glob,Grep,Edit,Write',

    '--allowedTools',
    'Read',
    'Glob',
    'Grep',
    `Edit(${worker.smokeFile})`,

    '--strict-mcp-config',

    '--safe-mode',

    '--no-session-persistence',

    '--disable-slash-commands',

    '--no-chrome',
  ];
}

function runClaudeWorker({
  command,
  worker,
  env,
}) {
  console.log(
    `Starting ${worker.role} Claude worker...`,
  );

  return new Promise(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const child =
        spawn(
          command,
          buildClaudeArgs(
            worker,
          ),
          {
            cwd:
              worker.path,

            env,

            windowsHide:
              true,

            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          },
        );

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer =
        setTimeout(
          () => {
            if (settled) {
              return;
            }

            settled = true;

            child.kill();

            rejectPromise(
              new Error(
                `${worker.role} worker timed out.`,
              ),
            );
          },
          CLAUDE_TIMEOUT_MS,
        );

      child.stdout.on(
        'data',
        (chunk) => {
          stdout +=
            chunk.toString();
        },
      );

      child.stderr.on(
        'data',
        (chunk) => {
          stderr +=
            chunk.toString();
        },
      );

      child.on(
        'error',
        (error) => {
          if (settled) {
            return;
          }

          settled = true;

          clearTimeout(
            timer,
          );

          rejectPromise(
            new Error(
              `${worker.role} failed to launch: ${error.message}`,
            ),
          );
        },
      );

      child.on(
        'close',
        (code) => {
          if (settled) {
            return;
          }

          settled = true;

          clearTimeout(
            timer,
          );

          if (code !== 0) {
            rejectPromise(
              new Error(
                `${worker.role} Claude exited with code ${code}:\n` +
                (
                  stderr.trim() ||
                  stdout.trim() ||
                  '(no output)'
                ),
              ),
            );

            return;
          }

          resolvePromise({
            worker,
            stdout:
              stdout.trim(),
          });
        },
      );
    },
  );
}

function runDiffAudit({
  orchestratorRoot,
  worker,
}) {
  const auditorPath =
    fileURLToPath(
      new URL(
        './ai-dev-diff-audit.mjs',
        import.meta.url,
      ),
    );

  console.log('');
  console.log(
    `Auditing ${worker.role} changes...`,
  );

  execFileSync(
    process.execPath,
    [
      auditorPath,

      '--worktree',
      worker.path,

      '--role',
      worker.role,

      '--allow',
      worker.smokeFile,
    ],
    {
      cwd:
        orchestratorRoot,

      stdio:
        'inherit',
    },
  );
}

function verifySmokeFile(
  worker,
) {
  const filePath =
    join(
      worker.path,
      worker.smokeFile,
    );

  if (
    !existsSync(filePath)
  ) {
    throw new Error(
      `${worker.role} did not create ${worker.smokeFile}.`,
    );
  }

  const actual =
    readFileSync(
      filePath,
      'utf8',
    ).trim();

  const expected =
    expectedContent(
      worker,
    );

  if (
    actual !== expected
  ) {
    throw new Error(
      `${worker.role} smoke file contents were incorrect.\n` +
      `Expected: ${expected}\n` +
      `Actual: ${actual}`,
    );
  }
}

async function main() {
  const repoRoot =
    getRepoRoot();

  requireCleanRepo(
    repoRoot,
  );

  const branch =
    requireSafeBranch(
      repoRoot,
    );

  requireBaseRef(
    repoRoot,
  );

  const sessionId =
    makeSessionId();

  const {
    root,
    workers,
  } =
    createDefinitions(
      repoRoot,
      sessionId,
    );

  preflightWorkers(
    repoRoot,
    workers,
  );

  const command =
    resolveClaudeCommand();

  const {
    env,
    stripped,
  } =
    buildClaudeEnv();

  console.log('');
  console.log(
    'CloudMarket Parallel Worker Smoke Test',
  );

  console.log(
    '======================================',
  );

  console.log(
    `Orchestrator branch: ${branch}`,
  );

  console.log(
    `Worker base: ${BASE_REF}`,
  );

  console.log(
    `Session: ${sessionId}`,
  );

  console.log(
    `Worktree root: ${root}`,
  );

  console.log('');

  console.log(
    'Claude tools:',
  );

  console.log(
    '  Read, Glob, Grep, Edit, Write',
  );

  console.log(
    '  Bash: UNAVAILABLE',
  );

  console.log('');

  console.log(
    `Environment variables stripped: ${stripped.length}`,
  );

  if (
    stripped.length > 0
  ) {
    console.log(
      stripped
        .map(
          (name) =>
            `  - ${name}`,
        )
        .join('\n'),
    );
  }

  console.log('');

  for (
    const worker
    of workers
  ) {
    createWorktree(
      repoRoot,
      worker,
    );
  }

  console.log('');
  console.log(
    'Launching 3 Claude workers simultaneously...',
  );

  const started =
    Date.now();

  const results =
    await Promise.all(
      workers.map(
        (worker) =>
          runClaudeWorker({
            command,
            worker,
            env,
          }),
      ),
    );

  const elapsed =
    Date.now() -
    started;

  console.log('');
  console.log(
    'All Claude processes exited successfully.',
  );

  for (
    const result
    of results
  ) {
    console.log('');
    console.log(
      `--- ${result.worker.role.toUpperCase()} ---`,
    );

    console.log(
      result.stdout ||
      '(no stdout)',
    );
  }

  for (
    const worker
    of workers
  ) {
    verifySmokeFile(
      worker,
    );

    runDiffAudit({
      orchestratorRoot:
        repoRoot,

      worker,
    });
  }

  console.log('');
  console.log(
    '======================================',
  );

  console.log(
    'PARALLEL WORKER SMOKE TEST PASSED',
  );

  console.log(
    '======================================',
  );

  console.log(
    `3 workers completed in ${elapsed}ms.`,
  );

  console.log('');

  console.log(
    'Verified:',
  );

  console.log(
    '  ✓ isolated worktrees',
  );

  console.log(
    '  ✓ simultaneous Claude execution',
  );

  console.log(
    '  ✓ sanitized environments',
  );

  console.log(
    '  ✓ Bash unavailable',
  );

  console.log(
    '  ✓ exact smoke-file contents',
  );

  console.log(
    '  ✓ post-run Git diff audits',
  );

  console.log('');

  console.log(
    'No commits were created.',
  );

  console.log(
    'No branches were pushed.',
  );

  console.log(
    'No database actions were performed.',
  );

  console.log(
    'No deployment was performed.',
  );

  console.log('');

  console.log(
    'Worktrees were intentionally left in place for human inspection.',
  );

  console.log('');

  for (
    const worker
    of workers
  ) {
    console.log(
      `${worker.role}:`,
    );

    console.log(
      `  ${worker.path}`,
    );

    console.log(
      `  ${worker.branch}`,
    );
  }
}

main().catch(
  (error) => {
    console.error('');
    console.error(
      'Parallel worker smoke test FAILED:',
    );

    console.error(
      error?.message ??
      String(error),
    );

    console.error('');
    console.error(
      'Do not accept or commit worker output.',
    );

    process.exitCode = 1;
  },
);