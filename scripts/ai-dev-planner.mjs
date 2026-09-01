#!/usr/bin/env node

/**
 * CloudMarket AI Development Planner
 *
 * READ-ONLY planning stage.
 *
 * This script:
 * - accepts one CloudMarket development request
 * - inventories tracked repository paths
 * - sends only safe repository metadata to GPT
 * - returns a schema-validated development plan
 *
 * This script DOES NOT:
 * - edit repository files
 * - launch Claude
 * - create worktrees
 * - run Bash/shell through an AI
 * - connect to databases
 * - run migrations
 * - deploy
 * - commit
 * - push
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Agent, run } from '@openai/agents';
import { z } from 'zod';

const PLANNER_MODEL =
  process.env.AI_DEV_PLANNER_MODEL?.trim() ||
  'gpt-5.6-sol';

const MAX_INVENTORY_PATHS = 1200;

const WorkerName = z.enum([
  'frontend',
  'backend',
  'database',
]);

const WorkerPlan = z.object({
  objective: z.string(),

  ownedPaths: z.array(z.string()),

  readOnlyContextPaths: z.array(z.string()),

  acceptanceCriteria: z.array(z.string()),

  dependencies: z.array(WorkerName),

  notes: z.string(),
});

const DevelopmentPlan = z.object({
  summary: z.string(),

  parallelizable: z.boolean(),

  riskLevel: z.enum([
    'low',
    'medium',
    'high',
  ]),

  frontend: WorkerPlan,

  backend: WorkerPlan,

  database: WorkerPlan,

  sharedFiles: z.array(z.string()),

  integrationOrder: z.array(WorkerName),

  humanReviewPoints: z.array(z.string()),

  blockedReason: z.string(),
});

const PLANNER_INSTRUCTIONS = `
You are the lead software architect for CloudMarket.

CloudMarket is a private, invite/application-gated multi-vendor marketplace
built with Next.js, PostgreSQL/Neon, Drizzle, authentication, Vercel, and
supporting services.

Your only job is to PLAN development work.

You have NO tools and must NEVER claim that you edited, executed, deployed,
migrated, committed, pushed, or tested anything.

Split the user's requested feature into exactly three engineering lanes:

1. frontend
2. backend
3. database

The "database" lane also owns authentication/authorization work when relevant.

IMPORTANT OWNERSHIP RULES:

- Workers will execute simultaneously in separate Git worktrees.
- No writable file should be assigned to more than one worker.
- sharedFiles MUST always be an empty array because the controlled integration
  and commit pipeline does not support shared/integration-only files.
- Every writable file MUST have exactly one worker owner.
- If multiple lanes need the same file, assign exactly one lane as the writer
  and give the other lanes read-only context for that file.
- If no single worker can safely own every required writable file, set
  parallelizable=false and explain the conflict in blockedReason.
- Do not defer required edits to sharedFiles.
- readOnlyContextPaths may overlap freely.
- Prefer narrow existing directories and files from the repository inventory.
- Existing directory ownership MUST end with "/".
- Existing file ownership MUST NOT end with "/".
- Never grant a worker broad ownership of a brand-new directory.
- For a brand-new directory, enumerate every exact new file path the worker may create.
- Do not represent a new directory as an extensionless writable path.
- Do not invent paths when an existing path clearly applies.
- A worker may have no implementation work; if so, give it an objective
  explaining that it should only inspect/validate its area and leave
  ownedPaths empty.

DATABASE SAFETY:

- Database work may create or modify schema/migration SOURCE FILES.
- Never propose executing a production migration.
- Never connect to the production database.
- Never propose modifying production data.
- Never expose credentials.
- Production migrations always require human approval.

GIT / DEPLOY SAFETY:

Workers may eventually modify their own worktree, but they may never:
- push directly to main
- force push
- deploy production
- merge into main
- change production environment variables

PARALLELISM:

Set parallelizable=false if the requested work fundamentally cannot be
implemented safely by the three workers concurrently.

If parallelizable=false, explain why in blockedReason.

If parallelizable=true, blockedReason must be an empty string.

integrationOrder should describe the safest order to combine worker results.

humanReviewPoints should identify anything a human should inspect before merge.

Return only the requested structured plan.
`.trim();

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readTask() {
  const task =
    process.argv.slice(2).join(' ').trim();

  if (!task) {
    throw new Error(
      'A development task is required.\n' +
      'Example:\n' +
      '  node scripts/ai-dev-planner.mjs ' +
      '"build seller profile editing"',
    );
  }

  return task;
}

function getRepoRoot() {
  return resolve(
    git([
      'rev-parse',
      '--show-toplevel',
    ]),
  );
}

function getCurrentBranch(repoRoot) {
  return git(
    ['branch', '--show-current'],
    {
      cwd: repoRoot,
    },
  );
}

function getRepositoryInventory(repoRoot) {
  const output = git(
    ['ls-files'],
    {
      cwd: repoRoot,
    },
  );

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
    .slice(0, MAX_INVENTORY_PATHS);
}

function getPackageMetadata(repoRoot) {
  try {
    const raw = readFileSync(
      resolve(repoRoot, 'package.json'),
      'utf8',
    );

    const pkg = JSON.parse(raw);

    return {
      name: pkg.name ?? '',
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(
        pkg.dependencies ?? {},
      ),
      devDependencies: Object.keys(
        pkg.devDependencies ?? {},
      ),
    };
  } catch {
    return {
      name: '',
      scripts: {},
      dependencies: [],
      devDependencies: [],
    };
  }
}

function validatePlan(plan) {
  if (
    plan.parallelizable &&
    plan.blockedReason.trim()
  ) {
    throw new Error(
      'Planner returned parallelizable=true ' +
      'with a non-empty blockedReason.',
    );
  }

  if (
    !plan.parallelizable &&
    !plan.blockedReason.trim()
  ) {
    throw new Error(
      'Planner returned parallelizable=false ' +
      'without explaining why.',
    );
  }

  if (
    !Array.isArray(
      plan.sharedFiles,
    )
  ) {
    throw new Error(
      'Planner omitted sharedFiles.',
    );
  }

  if (
    plan.sharedFiles.length > 0
  ) {
    throw new Error(
      'Controlled development requires sharedFiles to be empty. ' +
      'Assign each writable file to exactly one worker or set ' +
      'parallelizable=false with a blockedReason.',
    );
  }

  const workerEntries = [
    ['frontend', plan.frontend],
    ['backend', plan.backend],
    ['database', plan.database],
  ];

  const owners = new Map();

  for (const [workerName, worker] of workerEntries) {
    for (const path of worker.ownedPaths) {
      const normalized =
        path
          .replaceAll('\\', '/')
          .replace(/\/+$/, '')
          .toLowerCase();

      if (!normalized) {
        throw new Error(
          `${workerName} contains an empty owned path.`,
        );
      }

      const previousOwner =
        owners.get(normalized);

      if (previousOwner) {
        throw new Error(
          `Exact path ownership conflict: "${path}" ` +
          `belongs to both ${previousOwner} and ${workerName}.`,
        );
      }

      owners.set(
        normalized,
        workerName,
      );
    }
  }

  for (const sharedPath of plan.sharedFiles) {
    const normalized =
      sharedPath
        .replaceAll('\\', '/')
        .replace(/\/+$/, '')
        .toLowerCase();

    if (owners.has(normalized)) {
      throw new Error(
        `Shared file ownership conflict: ` +
        `"${sharedPath}" is also owned by ` +
        `${owners.get(normalized)}.`,
      );
    }
  }

  return plan;
}

function buildPlannerInput({
  task,
  branch,
  inventory,
  packageMetadata,
}) {
  return `
DEVELOPMENT REQUEST:

${task}

CURRENT DEVELOPMENT BRANCH:

${branch}

PACKAGE METADATA:

${JSON.stringify(
  packageMetadata,
  null,
  2,
)}

TRACKED REPOSITORY PATHS:

${inventory.join('\n')}

Create the safest implementation plan for the three isolated workers.
`.trim();
}

async function createPlan() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set.',
    );
  }

  const task = readTask();
  const repoRoot = getRepoRoot();
  const branch = getCurrentBranch(
    repoRoot,
  );

  const inventory =
    getRepositoryInventory(
      repoRoot,
    );

  const packageMetadata =
    getPackageMetadata(
      repoRoot,
    );

  const planner = new Agent({
    name: 'CloudMarket Development Architect',

    model: PLANNER_MODEL,

    instructions:
      PLANNER_INSTRUCTIONS,

    tools: [],

    outputType:
      DevelopmentPlan,
  });

  console.log('');
  console.log(
    'CloudMarket Development Planner',
  );
  console.log(
    '===============================',
  );
  console.log(
    `Model: ${PLANNER_MODEL}`,
  );
  console.log(
    `Branch: ${branch}`,
  );
  console.log(
    `Tracked paths supplied: ${inventory.length}`,
  );
  console.log('');
  console.log(
    'Generating read-only development plan...',
  );

  const result = await run(
    planner,
    buildPlannerInput({
      task,
      branch,
      inventory,
      packageMetadata,
    }),
    {
      maxTurns: 1,
    },
  );

  if (!result.finalOutput) {
    throw new Error(
      'Planner returned no final output.',
    );
  }

  const plan =
    validatePlan(
      result.finalOutput,
    );

  console.log('');
  console.log(
    'PLAN COMPLETE',
  );
  console.log(
    '=============',
  );
  console.log('');

  console.log(
    JSON.stringify(
      plan,
      null,
      2,
    ),
  );

  return plan;
}

createPlan().catch((error) => {
  console.error('');
  console.error(
    'AI development planner failed:',
  );
  console.error(
    error?.message ?? String(error),
  );

  process.exitCode = 1;
});