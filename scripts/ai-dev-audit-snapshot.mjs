#!/usr/bin/env node

import {
  createHash,
} from 'node:crypto';

import {
  readFileSync,
} from 'node:fs';

import {
  join,
} from 'node:path';

import {
  spawnSync,
} from 'node:child_process';

function normalizeRepoPath(
  path,
) {
  if (
    typeof path !== 'string'
  ) {
    throw new Error(
      'Worker change path must be a string.',
    );
  }

  const normalized =
    path
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '');

  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(
      normalized,
    ) ||
    normalized
      .split('/')
      .includes('..')
  ) {
    throw new Error(
      `Unsafe worker change path: ${path}`,
    );
  }

  return normalized;
}

function readStatusEntries({
  worktreePath,
  role,
}) {
  if (
    typeof worktreePath !== 'string' ||
    !worktreePath.trim()
  ) {
    throw new Error(
      `Missing worktree path for ${role ?? 'unknown'} worker.`,
    );
  }

  const result =
    spawnSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ],
      {
        cwd:
          worktreePath,

        encoding:
          'utf8',

        windowsHide:
          true,
      },
    );

  if (result.error) {
    throw new Error(
      `Could not read ${role} worker status: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Could not read ${role} worker status. Git exited ${result.status}.`,
    );
  }

  const records =
    result.stdout
      .split('\0');

  const entries = [];

  for (
    const record
    of records
  ) {
    if (!record) {
      continue;
    }

    if (record.length < 4) {
      throw new Error(
        `Malformed Git status record in ${role} worker.`,
      );
    }

    const status =
      record.slice(
        0,
        2,
      );

    if (
      status.includes('U')
    ) {
      throw new Error(
        `${role} contains an unresolved Git conflict.`,
      );
    }

    /*
     * Fail closed on renames/copies rather than risk interpreting
     * porcelain's second path differently from the integration lane.
     * A future lifecycle revision can support these explicitly.
     */
    if (
      status.includes('R') ||
      status.includes('C')
    ) {
      throw new Error(
        `${role} contains a rename/copy status that audit snapshot v1 does not support.`,
      );
    }

    const path =
      normalizeRepoPath(
        record.slice(3),
      );

    entries.push({
      role,
      path,

      operation:
        status.includes('D')
          ? 'delete'
          : 'copy',

      worktreePath,
    });
  }

  return entries;
}

function sha256File(
  filePath,
) {
  return createHash(
    'sha256',
  )
    .update(
      readFileSync(
        filePath,
      ),
    )
    .digest(
      'hex',
    );
}

function compareSnapshotEntries(
  left,
  right,
) {
  const roleCompare =
    left.role.localeCompare(
      right.role,
    );

  if (roleCompare !== 0) {
    return roleCompare;
  }

  const pathCompare =
    left.path.localeCompare(
      right.path,
    );

  if (pathCompare !== 0) {
    return pathCompare;
  }

  return left.operation.localeCompare(
    right.operation,
  );
}

export function collectWorkerAuditSnapshot(
  workers,
) {
  if (!Array.isArray(workers)) {
    throw new Error(
      'Session manifest workers must be an array.',
    );
  }

  const snapshot = [];

  for (
    const worker
    of workers
  ) {
    if (
      !worker ||
      typeof worker !== 'object' ||
      typeof worker.role !== 'string' ||
      typeof worker.path !== 'string'
    ) {
      throw new Error(
        'Session manifest contains an invalid worker record.',
      );
    }

    const entries =
      readStatusEntries({
        worktreePath:
          worker.path,

        role:
          worker.role,
      });

    for (
      const entry
      of entries
    ) {
      snapshot.push({
        role:
          entry.role,

        path:
          entry.path,

        operation:
          entry.operation,

        sha256:
          entry.operation ===
          'copy'
            ? sha256File(
                join(
                  entry.worktreePath,
                  entry.path,
                ),
              )
            : null,
      });
    }
  }

  snapshot.sort(
    compareSnapshotEntries,
  );

  return snapshot;
}