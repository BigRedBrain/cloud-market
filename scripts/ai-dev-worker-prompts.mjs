#!/usr/bin/env node

/**
 * CloudMarket AI Development Team - Worker Prompt Dry Run
 *
 * This script:
 * - runs the existing read-only GPT development planner
 * - parses its structured plan
 * - independently validates worker path ownership
 * - generates exact Claude worker instructions
 * - prints those instructions for human review
 *
 * This script DOES NOT:
 * - launch Claude
 * - create worktrees
 * - edit application files
 * - run migrations
 * - connect to databases
 * - commit
 * - push
 * - deploy
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROLES = [
  'frontend',
  'backend',
  'database',
];

const FORBIDDEN_ROOTS = [
  '.git',
  '.next',
  '.vercel',
  'node_modules',
];

function readTask() {
  const task =
    process.argv.slice(2).join(' ').trim();

  if (!task) {
    throw new Error(
      'A development task is required.\n' +
      'Example:\n' +
      '  node scripts/ai-dev-worker-prompts.mjs ' +
      '"build seller profile editing"',
    );
  }

  return task;
}

function normalizePath(value, label, options = {}) {
  if (typeof value !== 'string') {
    throw new Error(
      `${label} must contain strings only.`,
    );
  }

  const path = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');

  if (!path) {
    throw new Error(
      `${label} contains an empty path.`,
    );
  }

  if (
    path.startsWith('/') ||
    /^[a-zA-Z]:\//.test(path)
  ) {
    throw new Error(
      `${label} contains an absolute path: ${value}`,
    );
  }

  const segments =
    path.split('/');

  if (segments.includes('..')) {
    throw new Error(
      `${label} attempts to leave the repository: ${value}`,
    );
  }

  // "*" and "?" are treated as glob ownership and are not allowed.
  // Square brackets ARE allowed because Next.js uses paths such as [slug].
  const allowGlob =
  options.allowGlob === true;

if (
  !allowGlob &&
  (
    path.includes('*') ||
    path.includes('?')
  )
) {
  throw new Error(
    `${label} may not contain glob ownership: ${value}`,
  );
}

  const lower =
    path.toLowerCase();

  for (const root of FORBIDDEN_ROOTS) {
    if (
      lower === root ||
      lower.startsWith(`${root}/`)
    ) {
      throw new Error(
        `${label} targets forbidden path: ${value}`,
      );
    }
  }

  const fileName =
    lower.split('/').at(-1);

  if (
    fileName === '.env' ||
    fileName.startsWith('.env.')
  ) {
    throw new Error(
      `${label} may not target environment files: ${value}`,
    );
  }

  return path;
}

function pathsOverlap(left, right) {
  const a =
    left.toLowerCase();

  const b =
    right.toLowerCase();

  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`)
  );
}

function validatePlan(plan) {
  if (
    !plan ||
    typeof plan !== 'object'
  ) {
    throw new Error(
      'Planner returned an invalid plan object.',
    );
  }

  if (
    plan.parallelizable === true &&
    String(
      plan.blockedReason ?? '',
    ).trim()
  ) {
    throw new Error(
      'Planner marked the task parallelizable but also supplied a blocked reason.',
    );
  }

  if (
    plan.parallelizable === false &&
    !String(
      plan.blockedReason ?? '',
    ).trim()
  ) {
    throw new Error(
      'Planner blocked parallel execution without explaining why.',
    );
  }

  const ownership = [];

  for (const role of ROLES) {
    const worker =
      plan[role];

    if (
      !worker ||
      typeof worker !== 'object'
    ) {
      throw new Error(
        `Planner omitted ${role} worker.`,
      );
    }

    if (
      worker.dependencies?.includes(role)
    ) {
      throw new Error(
        `${role} worker depends on itself.`,
      );
    }

    for (
      const rawPath
      of worker.ownedPaths ?? []
    ) {
      const path =
        normalizePath(
          rawPath,
          `${role}.ownedPaths`,
        );

      for (
        const existing
        of ownership
      ) {
        if (
          existing.role !== role &&
          pathsOverlap(
            existing.path,
            path,
          )
        ) {
          throw new Error(
            'Writable ownership conflict:\n' +
            `  ${existing.role}: ${existing.path}\n` +
            `  ${role}: ${path}`,
          );
        }
      }

      ownership.push({
        role,
        path,
      });
    }

    for (
      const rawPath
      of worker.readOnlyContextPaths ?? []
    ) {
      normalizePath(
        rawPath,
        `${role}.readOnlyContextPaths`,
      );
    }
  }

  for (
    const rawPath
    of plan.sharedFiles ?? []
  ) {
   const sharedPath =
  normalizePath(
    rawPath,
    'sharedFiles',
    {
      allowGlob: true,
    },
  );

    for (
      const owned
      of ownership
    ) {
      if (
        pathsOverlap(
          sharedPath,
          owned.path,
        )
      ) {
        throw new Error(
          'Shared-file ownership conflict:\n' +
          `  shared: ${sharedPath}\n` +
          `  ${owned.role}: ${owned.path}`,
        );
      }
    }
  }

  const integrationOrder =
    plan.integrationOrder ?? [];

  if (
    integrationOrder.length !== 3 ||
    new Set(
      integrationOrder,
    ).size !== 3 ||
    !ROLES.every(
      (role) =>
        integrationOrder.includes(role),
    )
  ) {
    throw new Error(
      'integrationOrder must contain frontend, backend, and database exactly once.',
    );
  }

  return plan;
}

function runPlanner(task) {
  const plannerPath =
    fileURLToPath(
      new URL(
        './ai-dev-planner.mjs',
        import.meta.url,
      ),
    );

  const result =
    spawnSync(
      process.execPath,
      [
        plannerPath,
        task,
      ],
      {
        encoding: 'utf8',
        env: process.env,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      'Planner failed:\n' +
      (result.stderr || result.stdout),
    );
  }

  const output =
    result.stdout;

  const marker =
    'PLAN COMPLETE';

  const markerIndex =
    output.indexOf(marker);

  if (markerIndex === -1) {
    throw new Error(
      'Could not locate PLAN COMPLETE marker in planner output.',
    );
  }

  const jsonStart =
    output.indexOf(
      '{',
      markerIndex,
    );

  if (jsonStart === -1) {
    throw new Error(
      'Could not locate planner JSON.',
    );
  }

  const jsonText =
    output
      .slice(jsonStart)
      .trim();

  try {
    return JSON.parse(
      jsonText,
    );
  } catch (error) {
    throw new Error(
      'Could not parse planner JSON: ' +
      error.message,
    );
  }
}

function formatList(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0
  ) {
    return '  (none)';
  }

  return values
    .map(
      (value) =>
        `  - ${value}`,
    )
    .join('\n');
}

function buildWorkerPrompt({
  role,
  plan,
}) {
  const worker =
    plan[role];

  const roleTitle = {
    frontend:
      'FRONTEND ENGINEER',

    backend:
      'BACKEND ENGINEER',

    database:
      'DATABASE / AUTH ENGINEER',
  }[role];

  return `
CLOUDMARKET AI DEVELOPMENT WORKER

ROLE:
${roleTitle}

EXECUTION MODEL:
You are operating in your own isolated Git worktree and worker branch.

OVERALL FEATURE:
${plan.summary}

YOUR OBJECTIVE:
${worker.objective}

WRITE OWNERSHIP:
You may create or modify ONLY these repository-relative paths:

${formatList(worker.ownedPaths)}

READ-ONLY CONTEXT:
These paths are specifically relevant context. You may also inspect other
tracked repository files when needed, but you may not modify anything outside
WRITE OWNERSHIP.

${formatList(worker.readOnlyContextPaths)}

SHARED / INTEGRATION-ONLY FILES:
You MUST NOT modify these files. If your implementation requires one of them,
stop that portion of the work and report NEEDS_INTEGRATION.

${formatList(plan.sharedFiles)}

ACCEPTANCE CRITERIA:
${formatList(worker.acceptanceCriteria)}

DEPENDENCIES:
${formatList(worker.dependencies)}

ROLE NOTES:
${worker.notes || '(none)'}

STRICT WRITE RULES:

- Do not modify any path outside WRITE OWNERSHIP.
- Do not modify shared/integration-only files.
- Do not modify .env files.
- Do not modify .git, .next, .vercel, or node_modules.
- Do not change another worker's files.
- If a necessary edit falls outside ownership, report NEEDS_INTEGRATION.
- Do not silently expand your own scope.

GIT RULES:

- Work only in the assigned worker branch/worktree.
- Never switch to main.
- Never merge into main.
- Never push.
- Never force-push.
- Never rebase shared branches.
- Never use git reset --hard.
- Never delete branches.
- Never modify Git remotes.
- You may inspect git status and git diff.

DATABASE / PRODUCTION RULES:

- Never connect to the production database.
- Never modify production data.
- Never execute a production migration.
- Never run drizzle-kit push against production.
- Never deploy.
- Never invoke Vercel production deployment.
- Never modify Vercel environment variables.
- Never reveal credentials or secret environment values.

DATABASE-LANE SPECIAL RULE:

${
  role === 'database'
    ? `You may edit schema/auth SOURCE FILES listed in WRITE OWNERSHIP.
You may NOT execute production migrations.
If migration files are listed under SHARED / INTEGRATION-ONLY FILES,
do not modify them; report NEEDS_INTEGRATION instead.`
    : `Database schema and authorization source are owned by the database
worker unless explicitly listed in your WRITE OWNERSHIP.`
}

TESTING:

You may run safe local validation commands later when explicitly permitted by
the orchestrator.

Do not weaken tests merely to obtain a passing result.

COMPLETION RESPONSE:

When finished, report:

1. Summary of implementation
2. Files changed
3. Validation/tests run
4. Anything not completed
5. NEEDS_INTEGRATION items
6. Security or data concerns
7. Suggested integration order

Do not claim a test passed unless you actually ran it.
`.trim();
}

function main() {
  const task =
    readTask();

  console.log('');
  console.log(
    'CloudMarket Worker Prompt Dry Run',
  );
  console.log(
    '=================================',
  );
  console.log('');
  console.log(
    'Running read-only planner...',
  );

  const plan =
    validatePlan(
      runPlanner(task),
    );

  console.log('');
  console.log(
    'Planner safety validation: PASS',
  );

  console.log(
    `Risk level: ${plan.riskLevel}`,
  );

  console.log(
    `Parallelizable: ${plan.parallelizable}`,
  );

  if (
    !plan.parallelizable
  ) {
    console.log('');
    console.log(
      'EXECUTION BLOCKED',
    );
    console.log(
      plan.blockedReason,
    );
    return;
  }

  if (
    plan.riskLevel === 'high'
  ) {
    console.log('');
    console.log(
      'HIGH-RISK PLAN: human approval will be required before future execution.',
    );
  }

  for (
    const role
    of ROLES
  ) {
    console.log('');
    console.log(
      '='.repeat(72),
    );

    console.log(
      `${role.toUpperCase()} WORKER PROMPT`,
    );

    console.log(
      '='.repeat(72),
    );

    console.log('');

    console.log(
      buildWorkerPrompt({
        role,
        plan,
      }),
    );
  }

  console.log('');
  console.log(
    '='.repeat(72),
  );

  console.log(
    'DRY RUN COMPLETE',
  );

  console.log(
    '='.repeat(72),
  );

  console.log('');
  console.log(
    'No Claude processes were launched.',
  );

  console.log(
    'No worktrees were created.',
  );

  console.log(
    'No repository files were modified by an AI.',
  );

  console.log(
    'No database actions were performed.',
  );

  console.log(
    'No commits, pushes, merges, or deployments occurred.',
  );
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(
    'Worker prompt dry run failed:',
  );

  console.error(
    error?.message ??
    String(error),
  );

  process.exitCode = 1;
}