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
  readFileSync,
  writeFileSync,
} from 'node:fs';

import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runControlledIntegration,
} from './ai-integrate.mjs';

import {
  runCommitIntegration,
} from './ai-commit-integration.mjs';

import {
  runPushIntegration,
} from './ai-push-integration.mjs';

import {
  runOpenPr,
} from './ai-open-pr.mjs';

import {
  showSessionStatus,
} from './ai-session-status.mjs';


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

function printHelp() {
  console.log(`
CloudMarket AI Development Runner
=================================

Usage:
  node scripts/ai-dev-run.mjs "<development task>"
  node scripts/ai-dev-run.mjs --run-workers "<development task>"
  node scripts/ai-dev-run.mjs --approve-high-risk --run-workers "<development task>"
  node scripts/ai-dev-run.mjs --help

Options:
  --run-workers
      Explicitly allow planned AI workers to execute.

  --approve-high-risk
      Explicitly approve planner-classified high-risk execution.

  --help, -h
      Show this help and exit without planning or creating worktrees.

Safety:
  Help mode performs no AI planning, worker execution,
  commits, pushes, merges, deployments, or database actions.
`);
}

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
  const args =
    process.argv.slice(2);

  let approveHighRisk = false;
  let runWorkers = false;
  let showHelp = false;
  let integrateSessionId = null;
  let commitIntegrationSessionId = null;
  let pushIntegrationSessionId = null;
  let openPrSessionId = null;
  let statusSessionId = null;

  const taskParts = [];

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    const arg =
      args[index];

    if (arg === '--integrate') {
      const candidate =
        args[index + 1]?.trim();

      if (
        !candidate ||
        !/^\d{14}$/.test(candidate)
      ) {
        throw new Error(
          '--integrate requires a 14-digit session ID.',
        );
      }

      integrateSessionId = candidate;
      index += 1;
      continue;
    }

    if (arg === '--commit-integration') {
      const candidate =
        args[index + 1]?.trim();

      if (
        !candidate ||
        !/^\d{14}$/.test(candidate)
      ) {
        throw new Error(
          '--commit-integration requires a 14-digit session ID.',
        );
      }

      commitIntegrationSessionId =
        candidate;

      index += 1;
      continue;
    }

    if (arg === '--push-integration') {
      const candidate =
        args[index + 1]?.trim();

      if (
        !candidate ||
        !/^\d{14}$/.test(candidate)
      ) {
        throw new Error(
          '--push-integration requires a 14-digit session ID.',
        );
      }

      pushIntegrationSessionId =
        candidate;

      index += 1;
      continue;
    }

    if (arg === '--open-pr') {
      const candidate =
        args[index + 1]?.trim();

      if (
        !candidate ||
        !/^\d{14}$/.test(candidate)
      ) {
        throw new Error(
          '--open-pr requires a 14-digit session ID.',
        );
      }

      openPrSessionId =
        candidate;

      index += 1;
      continue;
    }

    if (arg === '--status') {
      const candidate =
        args[index + 1]?.trim();

      if (
        !candidate ||
        !/^\d{14}$/.test(candidate)
      ) {
        throw new Error(
          '--status requires a 14-digit session ID.',
        );
      }

      statusSessionId =
        candidate;

      index += 1;
      continue;
    }

    if (
      arg === '--help' ||
      arg === '-h'
    ) {
      showHelp = true;
      continue;
    }

    if (
      arg ===
      '--approve-high-risk'
    ) {
      approveHighRisk = true;
      continue;
    }

    if (
      arg ===
      '--run-workers'
    ) {
      runWorkers = true;
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
    taskParts
      .join(' ')
      .trim();

  if (showHelp) {
    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (integrateSessionId) {
    if (commitIntegrationSessionId) {
      throw new Error(
        '--integrate cannot be combined with --commit-integration.',
      );
    }

    if (pushIntegrationSessionId) {
      throw new Error(
        '--integrate cannot be combined with --push-integration.',
      );
    }

    if (openPrSessionId) {
      throw new Error(
        '--integrate cannot be combined with --open-pr.',
      );
    }

    if (runWorkers) {
      throw new Error(
        'Integration mode cannot be combined with --run-workers.',
      );
    }

    if (approveHighRisk) {
      throw new Error(
        'Integration mode cannot be combined with --approve-high-risk.',
      );
    }

    if (task) {
      throw new Error(
        'Integration mode accepts only --integrate <session-id>.',
      );
    }

    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (commitIntegrationSessionId) {
    if (pushIntegrationSessionId) {
      throw new Error(
        '--commit-integration cannot be combined with --push-integration.',
      );
    }

    if (openPrSessionId) {
      throw new Error(
        '--commit-integration cannot be combined with --open-pr.',
      );
    }

    if (runWorkers) {
      throw new Error(
        'Commit integration mode cannot be combined with --run-workers.',
      );
    }

    if (approveHighRisk) {
      throw new Error(
        'Commit integration mode cannot be combined with --approve-high-risk.',
      );
    }

    if (task) {
      throw new Error(
        'Commit integration mode accepts only --commit-integration <session-id>.',
      );
    }

    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (pushIntegrationSessionId) {
    if (openPrSessionId) {
      throw new Error(
        '--push-integration cannot be combined with --open-pr.',
      );
    }

    if (runWorkers) {
      throw new Error(
        'Push integration mode cannot be combined with --run-workers.',
      );
    }

    if (approveHighRisk) {
      throw new Error(
        'Push integration mode cannot be combined with --approve-high-risk.',
      );
    }

    if (task) {
      throw new Error(
        'Push integration mode accepts only --push-integration <session-id>.',
      );
    }

    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (openPrSessionId) {
    if (runWorkers) {
      throw new Error(
        'Open PR mode cannot be combined with --run-workers.',
      );
    }

    if (approveHighRisk) {
      throw new Error(
        'Open PR mode cannot be combined with --approve-high-risk.',
      );
    }

    if (task) {
      throw new Error(
        'Open PR mode accepts only --open-pr <session-id>.',
      );
    }

    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (statusSessionId) {
    if (
      integrateSessionId ||
      commitIntegrationSessionId ||
      pushIntegrationSessionId ||
      openPrSessionId ||
      runWorkers ||
      approveHighRisk ||
      task
    ) {
      throw new Error(
        'Status mode accepts only --status <session-id>.',
      );
    }

    return {
      task,
      approveHighRisk,
      runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
    };
  }

  if (!task) {
    throw new Error(
      'A development task is required.',
    );
  }

 return {
  task,
  approveHighRisk,
  runWorkers,
      showHelp,
      integrateSessionId,
      commitIntegrationSessionId,
      pushIntegrationSessionId,
      openPrSessionId,
      statusSessionId,
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
function formatPromptList(value) {
  const items =
    Array.isArray(value)
      ? value.filter(
          (item) =>
            typeof item === 'string' &&
            item.trim(),
        )
      : [];

  if (items.length === 0) {
    return '- (none)';
  }

  return items
    .map(
      (item) =>
        `- ${item}`,
    )
    .join('\n');
}

function normalizeNotes(value) {
  if (
    Array.isArray(value)
  ) {
    return value;
  }

  if (
    typeof value === 'string' &&
    value.trim()
  ) {
    return [
      value.trim(),
    ];
  }

  return [];
}

function buildWorkerExecutionPrompt({
  task,
  plan,
  role,
}) {
  const worker =
    plan[role];

  if (!worker) {
    throw new Error(
      `Missing worker plan for ${role}.`,
    );
  }

  return `
CLOUDMARKET DEVELOPMENT TASK
============================

TASK:
${task}

ROLE:
${role}

OBJECTIVE:
${worker.objective}

ACCEPTANCE CRITERIA:
${formatPromptList(
  worker.acceptanceCriteria,
)}

READ-ONLY CONTEXT PATHS:
${formatPromptList(
  worker.readOnlyContextPaths,
)}

DEPENDENCIES / CONTRACTS:
${formatPromptList(
  worker.dependencies,
)}

SHARED / INTEGRATION-ONLY FILES:
${formatPromptList(
  plan.sharedFiles,
)}

WORKER NOTES:
${formatPromptList(
  normalizeNotes(
    worker.notes,
  ),
)}

PLANNED INTEGRATION ORDER:
${formatPromptList(
  plan.integrationOrder,
)}

IMPORTANT:

You are working in an isolated Git worktree.

Other CloudMarket workers may be implementing dependency lanes simultaneously.
Do not attempt to inspect or modify their worktrees.

Implement only your assigned objective using your WRITE OWNERSHIP.

If another lane or a shared file must change, do not edit it.
Describe the required integration change in your final response.

Do not weaken authentication, authorization, validation, tenant isolation,
or existing security controls in order to make the implementation easier.
`.trim();
}

function launchClaudeWorker({
  repoRoot,
  task,
  plan,
  worker,
}) {
  return new Promise(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const role =
        worker.role;

      const workerPlan =
        plan[role];

      const ownedPaths =
        Array.isArray(
          workerPlan?.ownedPaths,
        )
          ? workerPlan.ownedPaths
          : [];

      if (
        ownedPaths.length === 0
      ) {
        resolvePromise({
          role,
          skipped: true,
          code: 0,
          stdout: '',
          stderr: '',
        });

        return;
      }

      const helperScript =
        resolve(
          repoRoot,
          'scripts',
          'ai-dev-claude-worker.mjs',
        );

      if (
        !existsSync(
          helperScript,
        )
      ) {
        rejectPromise(
          new Error(
            `Claude worker helper missing: ${helperScript}`,
          ),
        );

        return;
      }

      const args = [
        helperScript,
        '--worktree',
        worker.path,
        '--role',
        role,
      ];

      for (
        const ownedPath
        of ownedPaths
      ) {
        args.push(
          '--allow',
          ownedPath,
        );
      }

      const prompt =
        buildWorkerExecutionPrompt({
          task,
          plan,
          role,
        });

      const child =
        spawn(
          process.execPath,
          args,
          {
            cwd:
              repoRoot,

            env:
              process.env,

            stdio: [
              'pipe',
              'pipe',
              'pipe',
            ],

            windowsHide:
              true,
          },
        );

      let stdout = '';
      let stderr = '';

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
          rejectPromise(
            error,
          );
        },
      );

      child.on(
        'close',
        (code) => {
          resolvePromise({
            role,
            skipped: false,
            code:
              code ?? 1,
            stdout,
            stderr,
          });
        },
      );

      child.stdin.end(
        prompt,
      );
    },
  );
}

async function runParallelWorkers({
  repoRoot,
  task,
  plan,
  workers,
}) {
  console.log('');
  console.log(
    'PARALLEL CLAUDE EXECUTION',
  );

  console.log(
    'Launching isolated workers simultaneously...',
  );

  const executions =
    workers.map(
      (worker) =>
        launchClaudeWorker({
          repoRoot,
          task,
          plan,
          worker,
        }).catch(
          (error) => ({
            role:
              worker.role,

            skipped:
              false,

            code: 1,

            stdout: '',

            stderr:
              error.message,
          }),
        ),
    );

  const results =
    await Promise.all(
      executions,
    );

  console.log('');
  console.log(
    'WORKER RESULTS',
  );

  for (
    const result
    of results
  ) {
    console.log('');
    console.log(
      '=================================',
    );

    console.log(
      `${result.role.toUpperCase()} RESULT`,
    );

    console.log(
      '=================================',
    );

    if (
      result.skipped
    ) {
      console.log(
        'SKIPPED - no writable paths were assigned.',
      );

      continue;
    }

    if (
      result.stdout
    ) {
      process.stdout.write(
        result.stdout,
      );
    }

    if (
      result.stderr
    ) {
      process.stderr.write(
        result.stderr,
      );
    }

    console.log('');
    console.log(
      `Exit code: ${result.code}`,
    );
  }

  const failed =
    results.filter(
      (result) =>
        !result.skipped &&
        result.code !== 0,
    );

  if (
    failed.length > 0
  ) {
    console.error('');
    console.error(
      'WORKER EXECUTION FAILED',
    );

    console.error(
      `Failed lanes: ${
        failed
          .map(
            (result) =>
              result.role,
          )
          .join(', ')
      }`,
    );

    console.error(
      'Worktrees have been preserved for inspection.',
    );

    return false;
  }

  console.log('');
  console.log(
    'ALL WORKER DIFF AUDITS PASSED',
  );

  return true;
}

function getSessionManifestPath(
  worktreeRoot,
) {
  return join(
    worktreeRoot,
    'ai-session-manifest.json',
  );
}

function writeSessionManifest({
  repoRoot,
  task,
  plan,
  sessionId,
  taskSlug,
  worktreeRoot,
  workers,
}) {
  const manifestPath =
    getSessionManifestPath(
      worktreeRoot,
    );

  if (existsSync(manifestPath)) {
    throw new Error(
      'Session manifest already exists. Refusing to overwrite it.',
    );
  }

  const now =
    new Date().toISOString();

  const manifest = {
    manifestVersion: 1,

    sessionId,
    task,
    taskSlug,

    status:
      'worktrees-created',

    createdAt:
      now,

    updatedAt:
      now,

    baseRef:
      BASE_REF,

    baseCommit:
      git(
        [
          'rev-parse',
          BASE_REF,
        ],
        repoRoot,
      ),

    worktreeRoot,

    workers:
      workers.map(
        (worker) => ({
          role:
            worker.role,

          branch:
            worker.branch,

          path:
            worker.path,
        }),
      ),

    plan,
  };

  writeFileSync(
    manifestPath,
    JSON.stringify(
      manifest,
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('');
  console.log(
    'SESSION MANIFEST CREATED',
  );

  console.log(
    `  ${manifestPath}`,
  );
}

function updateSessionManifestStatus(
  worktreeRoot,
  status,
) {
  const manifestPath =
    getSessionManifestPath(
      worktreeRoot,
    );

  if (!existsSync(manifestPath)) {
    throw new Error(
      'Session manifest is missing. Refusing to update session status.',
    );
  }

  const manifest =
    JSON.parse(
      readFileSync(
        manifestPath,
        'utf8',
      ),
    );

  manifest.status =
    status;

  manifest.updatedAt =
    new Date().toISOString();

  writeFileSync(
    manifestPath,
    JSON.stringify(
      manifest,
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(
    `Session manifest status: ${status}`,
  );
}

async function main() {
  const {
    task,
    approveHighRisk,
    runWorkers,
    showHelp,
    integrateSessionId,
    commitIntegrationSessionId,
    pushIntegrationSessionId,
    openPrSessionId,
    statusSessionId,
  } =
    parseArgs();

  if (showHelp) {
    printHelp();
    return;
  }

  if (integrateSessionId) {
    runControlledIntegration({
      repoRoot:
        getRepoRoot(),

      sessionId:
        integrateSessionId,
    });

    return;
  }

  if (commitIntegrationSessionId) {
    runCommitIntegration({
      repoRoot:
        getRepoRoot(),

      sessionId:
        commitIntegrationSessionId,
    });

    return;
  }

  if (pushIntegrationSessionId) {
    runPushIntegration({
      repoRoot:
        getRepoRoot(),

      sessionId:
        pushIntegrationSessionId,
    });

    return;
  }

  if (openPrSessionId) {
    runOpenPr({
      repoRoot:
        getRepoRoot(),

      sessionId:
        openPrSessionId,
    });

    return;
  }

  if (statusSessionId) {
    showSessionStatus({
      repoRoot:
        getRepoRoot(),

      sessionId:
        statusSessionId,
    });

    return;
  }

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
  taskSlug,
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
if (
  plan.riskLevel === 'high' &&
  !approveHighRisk
) {
  console.log('');
  console.log(
    'Execution stopped at human approval gate.',
  );

  console.log(
    'No worktrees were created.',
  );

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

  return;
}
createWorkerWorktrees({
  repoRoot,
  worktreeRoot,
  workers,
});

writeSessionManifest({
  repoRoot,
  task,
  plan,
  sessionId,
  taskSlug,
  worktreeRoot,
  workers,
});

console.log('');
console.log(
  'WORKTREES CREATED',
);
if (!runWorkers) {
  console.log('');
  console.log(
    'Claude execution requires the explicit --run-workers flag.',
  );

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

  return;
}
const workerExecutionPassed =
  await runParallelWorkers({
    repoRoot,
    task,
    plan,
    workers,
  });

if (
  !workerExecutionPassed
) {
  updateSessionManifestStatus(
    worktreeRoot,
    'worker-audit-failed',
  );
  console.log('');
  console.log(
    'EXECUTION STOPPED FOR INSPECTION',
  );

  console.log(
    'No commits, pushes, merges, database actions, or deployments occurred.',
  );

  process.exitCode = 2;
  return;
}

console.log('');
console.log(
  '=================================',
);

updateSessionManifestStatus(
  worktreeRoot,
  'workers-audited',
);

console.log(
  'AI DEVELOPMENT WORKERS COMPLETE',
);

console.log(
  '=================================',
);

console.log('');
console.log(
  'All assigned worker diffs passed their ownership audits.',
);

console.log(
  'Worker worktrees have been preserved for human inspection.',
);

console.log('');
console.log(
  'No commits were created.',
);

console.log(
  'No pushes or merges occurred.',
);

console.log(
  'No database actions or migration execution occurred.',
);

console.log(
  'No deployments occurred.',
);

console.log('');
console.log(
  'STOP: human inspection is required before integration.',
);
 }

main().catch(
  (error) => {
    console.error('');
    console.error(
      'AI development runner failed:',
    );

    console.error(
      error?.message ??
      String(error),
    );

    process.exitCode = 1;
  },
);