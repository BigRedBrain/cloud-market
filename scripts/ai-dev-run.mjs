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

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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

  console.log('');
  console.log(
    'No worktrees were created.',
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