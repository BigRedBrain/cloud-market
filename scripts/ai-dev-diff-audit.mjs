#!/usr/bin/env node

/**
 * CloudMarket AI Development Team - Worker Diff Auditor
 *
 * Audits one worker worktree AFTER the worker finishes.
 *
 * The auditor:
 * - finds every tracked modification
 * - finds staged modifications
 * - finds untracked files
 * - rejects anything outside declared write ownership
 * - always rejects sensitive/generated roots
 *
 * It DOES NOT:
 * - edit files
 * - commit
 * - push
 * - merge
 * - deploy
 * - run migrations
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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
  const args = process.argv.slice(2);

  let worktree = '';
  let role = '';
  const allowed = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--worktree') {
      worktree = args[++i] ?? '';
      continue;
    }

    if (arg === '--role') {
      role = args[++i] ?? '';
      continue;
    }

    if (arg === '--allow') {
      allowed.push(
        args[++i] ?? '',
      );
      continue;
    }

    throw new Error(
      `Unknown argument: ${arg}`,
    );
  }

  if (!worktree) {
    throw new Error(
      '--worktree is required.',
    );
  }

  if (!role) {
    throw new Error(
      '--role is required.',
    );
  }

  if (allowed.length === 0) {
    throw new Error(
      'At least one --allow path is required.',
    );
  }

  return {
    worktree: resolve(worktree),
    role,
    allowed,
  };
}

function normalizeRepoPath(
  value,
  label,
) {
  if (
    typeof value !== 'string'
  ) {
    throw new Error(
      `${label} must be a string.`,
    );
  }

  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');

  if (
    !normalized ||
    normalized === '.'
  ) {
    throw new Error(
      `${label} contains an invalid path.`,
    );
  }

  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(
      normalized,
    )
  ) {
    throw new Error(
      `${label} must be repository-relative: ${value}`,
    );
  }

  const segments =
    normalized.split('/');

  if (
    segments.includes('..')
  ) {
    throw new Error(
      `${label} may not escape the repository: ${value}`,
    );
  }

  return normalized;
}

function normalizeAllowedPath(value) {
  const original =
    String(value).trim();

  const isDirectory =
    original.endsWith('/') ||
    original.endsWith('\\');

  const path =
    normalizeRepoPath(
      original,
      '--allow',
    );

  if (
    path.includes('*') ||
    path.includes('?')
  ) {
    throw new Error(
      `Writable ownership may not contain globs: ${value}`,
    );
  }

  return {
    path,
    isDirectory,
  };
}

function isForbiddenPath(path) {
  const lower =
    path.toLowerCase();

  for (
    const root
    of FORBIDDEN_ROOTS
  ) {
    if (
      lower === root ||
      lower.startsWith(
        `${root}/`,
      )
    ) {
      return true;
    }
  }

  const fileName =
    lower
      .split('/')
      .at(-1);

  if (
    fileName === '.env' ||
    fileName.startsWith(
      '.env.',
    )
  ) {
    return true;
  }

  return false;
}

function isAllowed(
  changedPath,
  ownership,
) {
  const changed =
    changedPath.toLowerCase();

  return ownership.some(
    ({
      path,
      isDirectory,
    }) => {
      const allowed =
        path.toLowerCase();

      if (isDirectory) {
        return (
          changed === allowed ||
          changed.startsWith(
            `${allowed}/`,
          )
        );
      }

      return changed === allowed;
    },
  );
}

function splitGitOutput(output) {
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map(
      (value) =>
        value.trim(),
    )
    .filter(Boolean);
}

function getChangedFiles(
  worktree,
) {
  const tracked =
    splitGitOutput(
      git(
        [
          'diff',
          '--name-only',
          '--no-renames',
          'HEAD',
        ],
        worktree,
      ),
    );

  const untracked =
    splitGitOutput(
      git(
        [
          'ls-files',
          '--others',
          '--exclude-standard',
        ],
        worktree,
      ),
    );

  return [
    ...new Set([
      ...tracked,
      ...untracked,
    ]),
  ]
    .map(
      (path) =>
        normalizeRepoPath(
          path,
          'changed file',
        ),
    )
    .sort();
}

function main() {
  const {
    worktree,
    role,
    allowed,
  } = parseArgs();

  const repoRoot =
    resolve(
      git(
        [
          'rev-parse',
          '--show-toplevel',
        ],
        worktree,
      ),
    );

  if (
    repoRoot.toLowerCase() !==
    worktree.toLowerCase()
  ) {
    throw new Error(
      'The supplied --worktree must be the root of a Git worktree.',
    );
  }

  const ownership =
    allowed.map(
      normalizeAllowedPath,
    );

  const changedFiles =
    getChangedFiles(
      worktree,
    );

  console.log('');
  console.log(
    'CloudMarket Worker Diff Audit',
  );
  console.log(
    '=============================',
  );
  console.log(
    `Role: ${role}`,
  );
  console.log(
    `Worktree: ${worktree}`,
  );

  console.log('');
  console.log(
    'Declared write ownership:',
  );

  for (
    const item
    of ownership
  ) {
    console.log(
      `  - ${item.path}${
        item.isDirectory
          ? '/'
          : ''
      }`,
    );
  }

  console.log('');
  console.log(
    'Changed files:',
  );

  if (
    changedFiles.length === 0
  ) {
    console.log(
      '  (none)',
    );

    console.log('');
    console.log(
      'AUDIT PASS',
    );

    console.log(
      'No files were changed.',
    );

    return;
  }

  for (
    const path
    of changedFiles
  ) {
    console.log(
      `  - ${path}`,
    );
  }

  const violations = [];

  for (
    const path
    of changedFiles
  ) {
    if (
      isForbiddenPath(path)
    ) {
      violations.push({
        path,
        reason:
          'forbidden or sensitive path',
      });

      continue;
    }

    if (
      !isAllowed(
        path,
        ownership,
      )
    ) {
      violations.push({
        path,
        reason:
          'outside declared write ownership',
      });
    }
  }

  console.log('');

  if (
    violations.length > 0
  ) {
    console.error(
      'AUDIT FAILED',
    );

    console.error(
      'The worker changed unauthorized files:',
    );

    for (
      const violation
      of violations
    ) {
      console.error(
        `  - ${violation.path}`,
      );

      console.error(
        `    ${violation.reason}`,
      );
    }

    console.error('');
    console.error(
      'Worker output must NOT be accepted or committed.',
    );

    process.exitCode = 2;

    return;
  }

  console.log(
    'AUDIT PASS',
  );

  console.log(
    `All ${changedFiles.length} changed file(s) are inside ${role} write ownership.`,
  );
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(
    'Worker diff audit failed:',
  );

  console.error(
    error?.message ??
    String(error),
  );

  process.exitCode = 1;
}