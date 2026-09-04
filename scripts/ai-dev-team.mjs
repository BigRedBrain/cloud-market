#!/usr/bin/env node

/**
 * CloudMarket AI Development Team - Worktree Bootstrap
 *
 * Phase 1 only:
 * - Accept a development task
 * - Require a clean Git working tree
 * - Refuse to run from main/master
 * - Create isolated frontend/backend/database worktrees
 *
 * This version does NOT:
 * - launch AI coding agents
 * - edit application files
 * - run migrations
 * - connect to databases
 * - deploy
 * - push branches
 * - merge anything
 */

import { execFileSync } from 'node:child_process';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  existsSync,
  mkdirSync,
} from 'node:fs';

const WORKERS = [
  'frontend',
  'backend',
  'database',
];

const BASE_REF =
  process.env.AI_DEV_BASE_REF?.trim() || 'origin/main';

/**
 * Run Git and return stdout.
 */
function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Read the requested development task.
 */
function readTask() {
  const task = process.argv.slice(2).join(' ').trim();

  if (!task) {
    throw new Error(
      'A development task is required.\n' +
      'Example:\n' +
      '  node scripts/ai-dev-team.mjs "build seller profiles"',
    );
  }

  return task;
}

/**
 * Convert a task into a safe Git/path slug.
 */
function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);

  return slug || 'cloudmarket-task';
}

/**
 * Generate a unique session ID.
 */
function makeSessionId() {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:T]/g, '')
    .slice(0, 14);
}

/**
 * Make sure we're inside a repository.
 */
function getRepoRoot() {
  return resolve(
    git(['rev-parse', '--show-toplevel']),
  );
}

/**
 * Require a completely clean working tree.
 */
function requireCleanRepo(repoRoot) {
  const status = git(
    ['status', '--porcelain'],
    { cwd: repoRoot },
  );

  if (status) {
    throw new Error(
      'Working tree is not clean.\n\n' +
      status +
      '\n\nCommit or stash changes before creating AI worktrees.',
    );
  }
}

/**
 * Never bootstrap development workers directly from main/master.
 */
function requireSafeCurrentBranch(repoRoot) {
  const branch = git(
    ['branch', '--show-current'],
    { cwd: repoRoot },
  );

  if (!branch) {
    throw new Error(
      'Detached HEAD detected. Switch to a normal branch first.',
    );
  }

  if (branch === 'main' || branch === 'master') {
    throw new Error(
      `Refusing to run from protected branch "${branch}".`,
    );
  }

  return branch;
}

/**
 * Confirm our requested base commit exists.
 */
function requireBaseRef(repoRoot) {
  try {
    git(
      ['rev-parse', '--verify', BASE_REF],
      { cwd: repoRoot },
    );
  } catch {
    throw new Error(
      `Base ref "${BASE_REF}" does not exist locally.\n` +
      'Run git fetch origin and try again.',
    );
  }
}

/**
 * Check whether a local branch already exists.
 */
function localBranchExists(repoRoot, branch) {
  const output = git(
    ['branch', '--list', branch],
    { cwd: repoRoot },
  );

  return output.length > 0;
}

/**
 * Build all worktree definitions before changing anything.
 */
function buildWorkerDefinitions({
  repoRoot,
  taskSlug,
  sessionId,
}) {
  const repoParent = dirname(repoRoot);

  const worktreeRoot = join(
    repoParent,
    'cloudmarket-ai-worktrees',
    `${taskSlug}-${sessionId}`,
  );

  const workers = WORKERS.map((role) => ({
    role,
    branch: `ai/${taskSlug}-${sessionId}-${role}`,
    path: join(worktreeRoot, role),
  }));

  return {
    worktreeRoot,
    workers,
  };
}

/**
 * Fail before modifying Git if any target already exists.
 */
function preflightWorkers(repoRoot, workers) {
  for (const worker of workers) {
    if (localBranchExists(repoRoot, worker.branch)) {
      throw new Error(
        `Branch already exists: ${worker.branch}`,
      );
    }

    if (existsSync(worker.path)) {
      throw new Error(
        `Worktree path already exists: ${worker.path}`,
      );
    }
  }
}

/**
 * Create one isolated worktree.
 */
function createWorktree(repoRoot, worker) {
  console.log('');
  console.log(`Creating ${worker.role} worker...`);
  console.log(`  branch: ${worker.branch}`);
  console.log(`  path:   ${worker.path}`);

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

/**
 * Main bootstrap.
 */
function main() {
  const task = readTask();
  const repoRoot = getRepoRoot();

  requireCleanRepo(repoRoot);

  const currentBranch =
    requireSafeCurrentBranch(repoRoot);

  requireBaseRef(repoRoot);

  const taskSlug = slugify(task);
  const sessionId = makeSessionId();

  const {
    worktreeRoot,
    workers,
  } = buildWorkerDefinitions({
    repoRoot,
    taskSlug,
    sessionId,
  });

  preflightWorkers(repoRoot, workers);

  console.log('');
  console.log('CloudMarket AI Development Team');
  console.log('================================');
  console.log(`Task:           ${task}`);
  console.log(`Current branch: ${currentBranch}`);
  console.log(`Worker base:    ${BASE_REF}`);
  console.log(`Session:        ${sessionId}`);
  console.log(`Worktree root:  ${worktreeRoot}`);

  console.log('');
  console.log('Planned workers:');

  for (const worker of workers) {
    console.log(
      `  ${worker.role.padEnd(9)} -> ${worker.branch}`,
    );
  }

  mkdirSync(worktreeRoot, {
    recursive: true,
  });

  for (const worker of workers) {
    createWorktree(repoRoot, worker);
  }

  console.log('');
  console.log('================================');
  console.log('WORKTREE BOOTSTRAP COMPLETE');
  console.log('================================');
  console.log('');

  for (const worker of workers) {
    console.log(
      `${worker.role.toUpperCase()}`,
    );
    console.log(`  Branch: ${worker.branch}`);
    console.log(`  Path:   ${worker.path}`);
    console.log('');
  }

  console.log('No AI agents were launched.');
  console.log('No application files were edited.');
  console.log('No database actions were performed.');
  console.log('No branches were pushed.');
  console.log('No commits were created.');
  console.log('');
  console.log('Human review required before enabling coding workers.');
}

try {
  main();
} catch (error) {
  console.error('');
  console.error('AI dev-team bootstrap failed:');
  console.error(error.message);
  process.exitCode = 1;
}