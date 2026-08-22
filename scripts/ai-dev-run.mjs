#!/usr/bin/env node

/**
 * CloudMarket AI Development Runner
 *
 * PHASE 1:
 * - accepts a development request
 * - requires a clean non-main branch
 * - consumes machine-readable planner JSON
 * - validates worker ownership
 * - blocks non-parallel plans
 * - requires explicit approval for high-risk plans
 *
 * This version DOES NOT:
 * - create worktrees
 * - launch Claude
 * - edit files
 * - commit
 * - push
 * - merge
 * - deploy
 * - access a database
 */
import {
  existsSync,
  mkdirSync,
} from 'node:fs';

import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const BASE_REF =
  process.env.AI_DEV_BASE_REF?.trim() ||
  'origin/main';

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

function git(args, cwd) {
  return execFileSync(
    'git',
    args,
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function parseArgs() {
  const raw =
    process.argv.slice(2);

  let approveHighRisk = false;
  const taskParts = [];

  for (const arg of raw) {
    if (arg === '--approve-high-risk') {
      approveHighRisk = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(
        `Unknown option: ${arg}`,
      );
    }

    taskParts.push(arg);
  }

  const task =
    taskParts.join(' ').trim();

  if (!task) {
    throw new Error(
      'A development task is required.\n\n' +
      'Example:\n' +
      '  node scripts/ai-dev-run.mjs ' +
      '"build seller profiles"',
    );
  }

  return {
    task,
    approveHighRisk,
  };
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

function requireCleanRepo(repoRoot) {
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
      'Working tree must be clean before AI development begins.\n\n' +
      status,
    );
  }
}

function requireSafeBranch(repoRoot) {
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
      `Refusing to operate from protected branch "${branch}".`,
    );
  }

  return branch;
}

function requireBaseRef(repoRoot) {
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
      `Base ref "${BASE_REF}" does not exist locally.\n` +
      'Run git fetch origin first.',
    );
  }
}

function normalizePath(
  value,
  label,
) {
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

  if (
    path
      .split('/')
      .includes('..')
  ) {
    throw new Error(
      `${label} escapes the repository: ${value}`,
    );
  }

  // Square brackets are valid Next.js dynamic route names.
  if (
    path.includes('*') ||
    path.includes('?')
  ) {
    throw new Error(
      `${label} contains a writable glob: ${value}`,
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
      `${label} targets an environment file: ${value}`,
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
      'Planner returned an invalid plan.',
    );
  }

  if (
    typeof plan.parallelizable !==
    'boolean'
  ) {
    throw new Error(
      'Planner omitted parallelizable.',
    );
  }

  if (
    ![
      'low',
      'medium',
      'high',
    ].includes(plan.riskLevel)
  ) {
    throw new Error(
      `Invalid risk level: ${plan.riskLevel}`,
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
            'Worker ownership conflict:\n' +
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
  }

  const integrationOrder =
    plan.integrationOrder ?? [];

  if (
    integrationOrder.length !== 3 ||
    new Set(integrationOrder).size !== 3 ||
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

function getPlan(task) {
  const bridgePath =
    fileURLToPath(
      new URL(
        './ai-dev-plan-json.mjs',
        import.meta.url,
      ),
    );

  const result =
    spawnSync(
      process.execPath,
      [
        bridgePath,
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
      (
        result.stderr ||
        result.stdout ||
        `exit code ${result.status}`
      ),
    );
  }

  try {
    return JSON.parse(
      result.stdout,
    );
  } catch (error) {
    throw new Error(
      `Could not parse planner JSON: ${error.message}`,
    );
  }
}

function printWorker(
  role,
  worker,
) {
  console.log('');
  console.log(
    `${role.toUpperCase()}`
  );

  console.log(
    `  Objective: ${worker.objective}`,
  );

  console.log(
    '  Write ownership:',
  );

  if (
    !worker.ownedPaths?.length
  ) {
    console.log(
      '    (none)',
    );
  } else {
    for (
      const path
      of worker.ownedPaths
    ) {
      console.log(
        `    - ${path}`,
      );
    }
  }

  console.log(
    '  Dependencies:',
  );

  if (
    !worker.dependencies?.length
  ) {
    console.log(
      '    (none)',
    );
  } else {
    for (
      const dependency
      of worker.dependencies
    ) {
      console.log(
        `    - ${dependency}`,
      );
    }
  }
}
function makeSessionId() {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:T]/g, '')
    .slice(0, 14);
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);

  return slug || 'cloudmarket-task';
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

function buildWorkerDefinitions({
  repoRoot,
  task,
}) {
  const sessionId =
    makeSessionId();

  const taskSlug =
    slugify(task);

  const worktreeRoot =
    join(
      dirname(repoRoot),
      'cloudmarket-ai-worktrees',
      `${taskSlug}-${sessionId}`,
    );

  const workers =
    ROLES.map(
      (role) => ({
        role,

        branch:
          `ai/${taskSlug}-${sessionId}-${role}`,

        path:
          join(
            worktreeRoot,
            role,
          ),
      }),
    );

  return {
    sessionId,
    taskSlug,
    worktreeRoot,
    workers,
  };
}

function preflightWorktrees(
  repoRoot,
  workers,
) {
  for (const worker of workers) {
    if (
      branchExists(
        repoRoot,
        worker.branch,
      )
    ) {
      throw new Error(
        `Worker branch already exists: ${worker.branch}`,
      );
    }

    if (
      existsSync(
        worker.path,
      )
    ) {
      throw new Error(
        `Worker path already exists: ${worker.path}`,
      );
    }
  }
}

function createWorkerWorktrees({
  repoRoot,
  worktreeRoot,
  workers,
}) {
  mkdirSync(
    worktreeRoot,
    {
      recursive: true,
    },
  );

  for (
    const worker
    of workers
  ) {
    console.log('');
    console.log(
      `Creating ${worker.role} worktree...`,
    );

    console.log(
      `  Branch: ${worker.branch}`,
    );

    console.log(
      `  Path:   ${worker.path}`,
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
}
function main() {
  const {
    task,
    approveHighRisk,
  } =
    parseArgs();

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

  console.log('');
  console.log(
    'CloudMarket AI Development Runner',
  );

  console.log(
    '=================================',
  );

  console.log(
    `Branch: ${branch}`,
  );

  console.log(
    `Worker base: ${BASE_REF}`,
  );

  console.log('');
  console.log(
    `Task: ${task}`,
  );

  console.log('');
  console.log(
    'Requesting structured architecture plan...',
  );

  const plan =
    validatePlan(
      getPlan(task),
    );
const {
  sessionId,
  worktreeRoot,
  workers,
} =
  buildWorkerDefinitions({
    repoRoot,
    task,
  });

preflightWorktrees(
  repoRoot,
  workers,
);

console.log('');
console.log(
  'WORKTREE PLAN',
);

console.log(
  `  Session: ${sessionId}`,
);

console.log(
  `  Root: ${worktreeRoot}`,
);

for (
  const worker
  of workers
) {
  console.log(
    `  ${worker.role}: ${worker.branch}`,
  );
}
  console.log('');
  console.log(
    'PLAN VALIDATION: PASS',
  );

  console.log(
    `Risk: ${plan.riskLevel}`,
  );

  console.log(
    `Parallelizable: ${plan.parallelizable}`,
  );

  console.log('');
  console.log(
    `Summary: ${plan.summary}`,
  );

  if (
    !plan.parallelizable
  ) {
    console.log('');
    console.log(
      'EXECUTION BLOCKED',
    );

    console.log(
      plan.blockedReason ||
      'Planner determined the task is not safely parallelizable.',
    );

    process.exitCode = 4;
    return;
  }

  if (
    plan.riskLevel === 'high' &&
    !approveHighRisk
  ) {
    console.log('');
    console.log(
      'HIGH-RISK HUMAN GATE',
    );

    console.log(
      'This plan requires explicit human approval before execution.',
    );

    console.log('');
    console.log(
      'Review the plan below, then rerun with:',
    );

    console.log(
      '  --approve-high-risk',
    );

    process.exitCode = 3;
  }

  for (
    const role
    of ROLES
  ) {
    printWorker(
      role,
      plan[role],
    );
  }

  console.log('');
  console.log(
    'SHARED / INTEGRATION-ONLY FILES',
  );

  if (
    !plan.sharedFiles?.length
  ) {
    console.log(
      '  (none)',
    );
  } else {
    for (
      const path
      of plan.sharedFiles
    ) {
      console.log(
        `  - ${path}`,
      );
    }
  }

  console.log('');
  console.log(
    'INTEGRATION ORDER',
  );

  for (
    const role
    of plan.integrationOrder
  ) {
    console.log(
      `  - ${role}`,
    );
  }

  console.log('');
  console.log(
    'HUMAN REVIEW POINTS',
  );

  for (
    const item
    of plan.humanReviewPoints ?? []
  ) {
    console.log(
      `  - ${item}`,
    );
  }

  console.log('');
  console.log(
    '=================================',
  );

  if (
    plan.riskLevel === 'high' &&
    !approveHighRisk
  ) {
    console.log(
      'PREFLIGHT COMPLETE - EXECUTION NOT APPROVED',
    );
  } else {
    console.log(
      'PREFLIGHT COMPLETE - PLAN APPROVED',
    );
  }

  console.log(
    '=================================',
  );
createWorkerWorktrees({
  repoRoot,
  worktreeRoot,
  workers,
});

console.log('');
console.log(
  'WORKTREES CREATED',
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

console.log('');
console.log(
  'No Claude workers were launched.',
);

console.log(
  'No files were edited by AI.',
);

console.log(
  'No database actions occurred.',
);

console.log(
  'No commits, pushes, merges, or deployments occurred.',
);
 

  console.log(
    'No Claude workers were launched.',
  );

  console.log(
    'No files were edited.',
  );

  console.log(
    'No database actions occurred.',
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
    'AI development runner preflight failed:',
  );

  console.error(
    error?.message ??
    String(error),
  );

  process.exitCode = 1;
}