#!/usr/bin/env node

/**
 * CloudMarket isolated Claude development worker.
 *
 * This script:
 * - runs one Claude worker inside one Git worktree
 * - strips sensitive environment variables
 * - exposes Read, Glob, Grep, Edit, and Write only
 * - does NOT expose Bash
 * - does NOT commit, push, merge, deploy, or access databases
 * - runs the independent Git diff auditor afterward
 *
 * The worker prompt is received through stdin.
 */

import {
  existsSync,
  statSync,
} from 'node:fs';

import {
  dirname,
  resolve,
} from 'node:path';

import {
  fileURLToPath,
} from 'node:url';

import {
  spawnSync,
} from 'node:child_process';

const ROLES =
  new Set([
    'frontend',
    'backend',
    'database',
  ]);

const scriptDir =
  dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );

const repoRoot =
  resolve(
    scriptDir,
    '..',
  );

const auditScript =
  resolve(
    scriptDir,
    'ai-dev-diff-audit.mjs',
  );

const SENSITIVE_EXACT =
  new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'AUTH_SECRET',
    'NEXTAUTH_SECRET',
    'NEON_API_KEY',
    'BLOB_READ_WRITE_TOKEN',
    'VERCEL_BLOB_READ_WRITE_TOKEN',
    'RESEND_API_KEY',
    'INVITE_SECRET',
    'CRON_SECRET',
  ]);

const SENSITIVE_PATTERNS = [
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /DATABASE_URL/i,
  /API_KEY/i,
  /PRIVATE_KEY/i,
  /ACCESS_KEY/i,
  /NEON/i,
  /BLOB/i,
  /RESEND/i,
];

function fail(message) {
  console.error('');
  console.error(
    `AI Claude worker failed: ${message}`,
  );

  process.exit(1);
}

function requireValue(
  args,
  index,
  flag,
) {
  const value =
    args[index + 1];

  if (
    !value ||
    value.startsWith('--')
  ) {
    fail(
      `${flag} requires a value.`,
    );
  }

  return value;
}

function parseArgs() {
  const args =
    process.argv.slice(2);

  let worktree = '';
  let role = '';

  const allow = [];

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    const arg =
      args[index];

    if (
      arg === '--worktree'
    ) {
      worktree =
        requireValue(
          args,
          index,
          arg,
        );

      index += 1;
      continue;
    }

    if (
      arg === '--role'
    ) {
      role =
        requireValue(
          args,
          index,
          arg,
        );

      index += 1;
      continue;
    }

    if (
      arg === '--allow'
    ) {
      allow.push(
        requireValue(
          args,
          index,
          arg,
        ),
      );

      index += 1;
      continue;
    }

    fail(
      `Unknown argument: ${arg}`,
    );
  }

  if (!worktree) {
    fail(
      '--worktree is required.',
    );
  }

  if (!role) {
    fail(
      '--role is required.',
    );
  }

  if (!ROLES.has(role)) {
    fail(
      `Invalid role: ${role}`,
    );
  }

  if (
    allow.length === 0
  ) {
    fail(
      'At least one --allow path is required.',
    );
  }

  return {
    worktree:
      resolve(worktree),

    role,

    allow:
      [...new Set(allow)],
  };
}

function sanitizeEnvironment() {
  const safeEnvironment =
    {};

  const removed = [];

  for (
    const [
      key,
      value,
    ]
    of Object.entries(
      process.env,
    )
  ) {
    const upper =
      key.toUpperCase();

    const sensitive =
      SENSITIVE_EXACT.has(
        upper,
      ) ||
      SENSITIVE_PATTERNS.some(
        (pattern) =>
          pattern.test(key),
      );

    if (sensitive) {
      removed.push(key);
      continue;
    }

    safeEnvironment[key] =
      value;
  }

  return {
    safeEnvironment,
    removed,
  };
}

function getClaudeCommand() {
  const explicit =
    process.env
      .AI_DEV_CLAUDE_BIN
      ?.trim();

  if (explicit) {
    return explicit;
  }

  if (
    process.platform ===
    'win32'
  ) {
    const appData =
      process.env.APPDATA;

    if (appData) {
      const windowsClaude =
        resolve(
          appData,
          'npm',
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe',
        );

      if (
        existsSync(
          windowsClaude,
        )
      ) {
        return windowsClaude;
      }
    }
  }

  return 'claude';
}

function readPrompt() {
  let input = '';

  try {
    input =
      process.stdin.isTTY
        ? ''
        : requireStdin();
  } catch (error) {
    fail(
      `Could not read worker prompt: ${error.message}`,
    );
  }

  if (!input.trim()) {
    fail(
      'Worker prompt must be provided through stdin.',
    );
  }

  return input.trim();
}

function requireStdin() {
  const fs =
    requireModuleShim();

  return fs.readFileSync(
    0,
    'utf8',
  );
}

function requireModuleShim() {
  return {
    readFileSync(
      descriptor,
      encoding,
    ) {
      return readFileSyncNative(
        descriptor,
        encoding,
      );
    },
  };
}

import {
  readFileSync as
    readFileSyncNative,
} from 'node:fs';

function buildPrompt({
  role,
  allow,
  requestedPrompt,
}) {
  const ownership =
    allow
      .map(
        (path) =>
          `- ${path}`,
      )
      .join('\n');

  return `
${requestedPrompt}

--------------------------------------------------
CLOUDMARKET ENFORCED WORKER BOUNDARY
--------------------------------------------------

ROLE:
${role}

WRITE OWNERSHIP:
${ownership}

MANDATORY RULES:

1. Inspect the existing implementation before editing.

2. You may READ any repository file needed for context.

3. You may WRITE or EDIT ONLY paths listed under WRITE OWNERSHIP.

4. Do not modify files outside your ownership even if doing so would make the feature easier.

5. Shared or integration-only changes must be described in your final response instead of edited.

6. Do not use or request Bash, shell commands, Git commands, npm commands, database commands, migration execution, deployment commands, or environment secrets.

7. Do not commit, push, merge, deploy, or modify Git state.

8. Do not connect to any database.

9. Do not run production migrations.

10. Do not access or modify .env files.

11. Preserve existing CloudMarket architecture and security boundaries.

12. Prefer the smallest implementation that satisfies the assigned objective and acceptance criteria.

13. When finished, summarize:
    - files changed
    - implementation completed
    - integration work still required
    - risks or assumptions

Finish with exactly:

${role.toUpperCase()} WORKER COMPLETE
`.trim();
}

function runClaude({
  worktree,
  role,
  prompt,
}) {
  const {
    safeEnvironment,
    removed,
  } =
    sanitizeEnvironment();

  const command =
    getClaudeCommand();

  const claudeArgs = [
    '--print',
    '--permission-mode',
    'default',
    '--tools',
    'Read,Glob,Grep,Edit,Write',
    '--allowedTools',
    'Read,Glob,Grep,Edit,Write',
    '--disallowedTools',
    'Bash',
    '--strict-mcp-config',
    '--safe-mode',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--no-chrome',
  ];

  const model =
    process.env
      .AI_DEV_CLAUDE_MODEL
      ?.trim();

  if (model) {
    claudeArgs.push(
      '--model',
      model,
    );
  }

  console.log('');
  console.log(
    `Launching ${role} Claude worker...`,
  );

  console.log(
    `Worktree: ${worktree}`,
  );

  console.log(
    `Sensitive environment variables stripped: ${removed.length}`,
  );

  const result =
    spawnSync(
      command,
      claudeArgs,
      {
        cwd:
          worktree,

        env:
          safeEnvironment,

        input:
          prompt,

        encoding:
          'utf8',

        maxBuffer:
          20 * 1024 * 1024,

        windowsHide:
          true,
      },
    );

  if (result.error) {
    fail(
      `Claude could not start: ${result.error.message}`,
    );
  }

  if (result.stdout) {
    process.stdout.write(
      result.stdout,
    );
  }

  if (result.stderr) {
    process.stderr.write(
      result.stderr,
    );
  }

  if (
    result.status !== 0
  ) {
    fail(
      `Claude exited with code ${result.status}.`,
    );
  }
}

function runAudit({
  worktree,
  role,
  allow,
}) {
  console.log('');
  console.log(
    `Running ${role} diff audit...`,
  );

  const args = [
    auditScript,
    '--worktree',
    worktree,
    '--role',
    role,
  ];

  for (
    const path
    of allow
  ) {
    args.push(
      '--allow',
      path,
    );
  }

  const result =
    spawnSync(
      process.execPath,
      args,
      {
        cwd:
          repoRoot,

        stdio:
          'inherit',

        env:
          process.env,

        windowsHide:
          true,
      },
    );

  if (result.error) {
    fail(
      `Diff auditor could not start: ${result.error.message}`,
    );
  }

  if (
    result.status !== 0
  ) {
    process.exit(
      result.status || 2,
    );
  }
}

function main() {
  const {
    worktree,
    role,
    allow,
  } =
    parseArgs();

  if (
    !existsSync(
      worktree,
    ) ||
    !statSync(
      worktree,
    ).isDirectory()
  ) {
    fail(
      `Worktree does not exist: ${worktree}`,
    );
  }

  if (
    !existsSync(
      auditScript,
    )
  ) {
    fail(
      `Diff auditor missing: ${auditScript}`,
    );
  }

  const requestedPrompt =
    readPrompt();

  const prompt =
    buildPrompt({
      role,
      allow,
      requestedPrompt,
    });

  runClaude({
    worktree,
    role,
    prompt,
  });

  runAudit({
    worktree,
    role,
    allow,
  });

  console.log('');
  console.log(
    `${role.toUpperCase()} WORKER EXECUTION PASSED`,
  );

  console.log(
    'No commit, push, merge, database action, or deployment occurred.',
  );
}

main();