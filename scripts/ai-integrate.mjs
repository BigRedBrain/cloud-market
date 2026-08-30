#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  execFileSync,
} from 'node:child_process';

import {
  createHash,
} from 'node:crypto';

import {
  pathToFileURL,
} from 'node:url';

const ROLES = [
  'frontend',
  'backend',
  'database',
];

function git(
  args,
  cwd,
) {
  return execFileSync(
    'git',
    args,
    {
      cwd,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
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
      'Working tree must be clean before controlled integration begins.\n\n' +
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

  if (
    !branch ||
    branch === 'main' ||
    branch === 'master'
  ) {
    throw new Error(
      'Controlled integration must run from a non-main branch.',
    );
  }

  return branch;
}

function branchExists(
  repoRoot,
  branch,
) {
  try {
    execFileSync(
      'git',
      [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ],
      {
        cwd: repoRoot,
        stdio: 'ignore',
      },
    );

    return true;
  } catch {
    return false;
  }
}

function normalizeRepoPath(
  value,
) {
  const normalized =
    String(value ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/g, '');

  if (
    !normalized ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('/')
  ) {
    throw new Error(
      `Unsafe repository path: ${value}`,
    );
  }

  return normalized;
}

function pathIsInside(
  parent,
  candidate,
) {
  const rel =
    relative(
      resolve(parent),
      resolve(candidate),
    );

  return (
    rel === '' ||
    (
      !rel.startsWith('..') &&
      !isAbsolute(rel)
    )
  );
}

function pathIsOwned(
  changedPath,
  ownedPaths,
) {
  const changed =
    normalizeRepoPath(
      changedPath,
    );

  return (
    ownedPaths ?? []
  ).some(
    (value) => {
      const owned =
        normalizeRepoPath(
          value,
        );

      return (
        changed === owned ||
        changed.startsWith(
          `${owned}/`,
        )
      );
    },
  );
}

function findSessionManifest({
  repoRoot,
  sessionId,
}) {
  const sessionsRoot =
    resolve(
      dirname(repoRoot),
      'cloudmarket-ai-worktrees',
    );

  if (
    !existsSync(
      sessionsRoot,
    )
  ) {
    throw new Error(
      'AI worktree directory does not exist.',
    );
  }

  const matches =
    readdirSync(
      sessionsRoot,
      {
        withFileTypes: true,
      },
    )
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.endsWith(
            `-${sessionId}`,
          ),
      )
      .map(
        (entry) =>
          join(
            sessionsRoot,
            entry.name,
            'ai-session-manifest.json',
          ),
      )
      .filter(
        (candidate) =>
          existsSync(candidate),
      );

  if (
    matches.length === 0
  ) {
    throw new Error(
      `No session manifest found for ${sessionId}.`,
    );
  }

  if (
    matches.length !== 1
  ) {
    throw new Error(
      `Multiple manifests found for ${sessionId}. Integration refused.`,
    );
  }

  return {
    sessionsRoot,
    manifestPath:
      matches[0],
  };
}

function validateManifest({
  repoRoot,
  sessionsRoot,
  manifestPath,
  sessionId,
}) {
  let manifest;

  try {
    manifest =
      JSON.parse(
        readFileSync(
          manifestPath,
          'utf8',
        ),
      );
  } catch {
    throw new Error(
      'Session manifest contains invalid JSON.',
    );
  }

  if (
    manifest.manifestVersion !== 1
  ) {
    throw new Error(
      'Unsupported session manifest version.',
    );
  }

  if (
    manifest.sessionId !==
    sessionId
  ) {
    throw new Error(
      'Manifest session ID does not match the requested session.',
    );
  }

  if (
    manifest.status !==
    'workers-audited'
  ) {
    throw new Error(
      `Session is not integration-ready. Required status: workers-audited. Current status: ${manifest.status ?? 'unknown'}.`,
    );
  }

  if (
    typeof manifest.baseCommit !==
      'string' ||
    !/^[0-9a-f]{40,64}$/i.test(
      manifest.baseCommit,
    )
  ) {
    throw new Error(
      'Manifest base commit is invalid.',
    );
  }

  try {
    execFileSync(
      'git',
      [
        'cat-file',
        '-e',
        `${manifest.baseCommit}^{commit}`,
      ],
      {
        cwd: repoRoot,
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error(
      'Recorded base commit does not exist locally.',
    );
  }

  if (
    !manifest.worktreeRoot ||
    !pathIsInside(
      sessionsRoot,
      manifest.worktreeRoot,
    )
  ) {
    throw new Error(
      'Manifest worktree root is outside the allowed AI worktree directory.',
    );
  }

  if (
    resolve(
      dirname(
        manifestPath,
      ),
    ) !==
    resolve(
      manifest.worktreeRoot,
    )
  ) {
    throw new Error(
      'Manifest location does not match its recorded worktree root.',
    );
  }

  const workers =
    manifest.workers ?? [];

  if (
    workers.length !== 3 ||
    new Set(
      workers.map(
        (worker) =>
          worker.role,
      ),
    ).size !== 3 ||
    !ROLES.every(
      (role) =>
        workers.some(
          (worker) =>
            worker.role === role,
        ),
    )
  ) {
    throw new Error(
      'Manifest must contain exactly one frontend, backend, and database worker.',
    );
  }

  const integrationOrder =
    manifest.plan
      ?.integrationOrder ??
    [];

  if (
    integrationOrder.length !== 3 ||
    new Set(
      integrationOrder,
    ).size !== 3 ||
    !ROLES.every(
      (role) =>
        integrationOrder.includes(
          role,
        ),
    )
  ) {
    throw new Error(
      'Manifest integration order is invalid.',
    );
  }

  if (
    manifest.plan
      ?.sharedFiles
      ?.length
  ) {
    throw new Error(
      'Controlled integration currently refuses shared/integration-only files. Human integration is required.',
    );
  }

  for (
    const worker
    of workers
  ) {
    const expectedPath =
      join(
        manifest.worktreeRoot,
        worker.role,
      );

    if (
      resolve(
        worker.path,
      ) !==
      resolve(
        expectedPath,
      )
    ) {
      throw new Error(
        `${worker.role} worktree path does not match the manifest session layout.`,
      );
    }

    if (
      !existsSync(
        worker.path,
      )
    ) {
      throw new Error(
        `${worker.role} worktree is missing.`,
      );
    }

    const head =
      git(
        [
          'rev-parse',
          'HEAD',
        ],
        worker.path,
      );

    if (
      head !==
      manifest.baseCommit
    ) {
      throw new Error(
        `${worker.role} HEAD no longer matches the recorded base commit.`,
      );
    }

    const branch =
      git(
        [
          'branch',
          '--show-current',
        ],
        worker.path,
      );

    if (
      branch !==
      worker.branch
    ) {
      throw new Error(
        `${worker.role} branch no longer matches the manifest.`,
      );
    }

    const lane =
      manifest.plan
        ?.[worker.role];

    if (
      !lane ||
      !Array.isArray(
        lane.ownedPaths,
      )
    ) {
      throw new Error(
        `${worker.role} ownership information is missing.`,
      );
    }
  }

  return manifest;
}

function readStatusEntries({
  worktreePath,
  role,
}) {
  const output =
    execFileSync(
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

        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    );

  const records =
    output
      .split('\0')
      .filter(Boolean);

  const entries = [];

  for (
    const record
    of records
  ) {
    if (
      record.length < 4
    ) {
      throw new Error(
        `Malformed Git status record in ${role}.`,
      );
    }

    const status =
      record.slice(
        0,
        2,
      );

    if (
      status.includes('R') ||
      status.includes('C')
    ) {
      throw new Error(
        `${role} contains a rename/copy operation. Controlled integration does not support renames or copies yet.`,
      );
    }

    if (
      status.includes('U')
    ) {
      throw new Error(
        `${role} contains an unresolved Git conflict.`,
      );
    }

    const changedPath =
      normalizeRepoPath(
        record.slice(3),
      );

    entries.push({
      role,
      status,
      path:
        changedPath,

      operation:
        status.includes('D')
          ? 'delete'
          : 'copy',

      worktreePath,
    });
  }

  return entries;
}

function collectAuditedChanges(
  manifest,
) {
  const changes = [];
  const claimed =
    new Map();

  for (
    const worker
    of manifest.workers
  ) {
    const ownedPaths =
      manifest.plan[
        worker.role
      ].ownedPaths;

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
      if (
        !pathIsOwned(
          entry.path,
          ownedPaths,
        )
      ) {
        throw new Error(
          `${worker.role} changed an unowned path: ${entry.path}`,
        );
      }

      if (
        claimed.has(
          entry.path,
        )
      ) {
        throw new Error(
          `Multiple workers changed the same path: ${entry.path}`,
        );
      }

      for (
        const previousPath
        of claimed.keys()
      ) {
        if (
          entry.path.startsWith(
            `${previousPath}/`,
          ) ||
          previousPath.startsWith(
            `${entry.path}/`,
          )
        ) {
          throw new Error(
            `Overlapping worker paths detected: ${previousPath} and ${entry.path}`,
          );
        }
      }

      claimed.set(
        entry.path,
        worker.role,
      );

      changes.push(
        entry,
      );
    }
  }

  return changes;
}

function createIntegrationWorktree({
  repoRoot,
  manifest,
}) {
  const integrationPath =
    join(
      manifest.worktreeRoot,
      'integration',
    );

  const integrationBranch =
    `ai/integrate-${manifest.sessionId}`;

  if (
    existsSync(
      integrationPath,
    )
  ) {
    throw new Error(
      'Integration worktree already exists. Refusing to overwrite it.',
    );
  }

  if (
    branchExists(
      repoRoot,
      integrationBranch,
    )
  ) {
    throw new Error(
      'Integration branch already exists. Refusing to reuse it.',
    );
  }

  execFileSync(
    'git',
    [
      'worktree',
      'add',
      '-b',
      integrationBranch,
      integrationPath,
      manifest.baseCommit,
    ],
    {
      cwd:
        repoRoot,

      stdio:
        'inherit',
    },
  );

  return {
    integrationPath,
    integrationBranch,
  };
}

function applyChanges({
  manifest,
  changes,
  integrationPath,
}) {
  for (
    const role
    of manifest.plan
      .integrationOrder
  ) {
    console.log('');
    console.log(
      `Applying ${role} lane...`,
    );

    const laneChanges =
      changes.filter(
        (change) =>
          change.role === role,
      );

    if (
      laneChanges.length === 0
    ) {
      console.log(
        '  (no changes)',
      );

      continue;
    }

    for (
      const change
      of laneChanges
    ) {
      const target =
        join(
          integrationPath,
          change.path,
        );

      if (
        !pathIsInside(
          integrationPath,
          target,
        )
      ) {
        throw new Error(
          `Unsafe integration target: ${change.path}`,
        );
      }

      if (
        change.operation ===
        'delete'
      ) {
        rmSync(
          target,
          {
            force: true,
          },
        );

        console.log(
          `  DELETE ${change.path}`,
        );

        continue;
      }

      const source =
        join(
          change.worktreePath,
          change.path,
        );

      if (
        !existsSync(
          source,
        )
      ) {
        throw new Error(
          `Worker source disappeared: ${change.path}`,
        );
      }

      const stat =
        lstatSync(
          source,
        );

      if (
        !stat.isFile()
      ) {
        throw new Error(
          `Controlled integration supports regular files only: ${change.path}`,
        );
      }

      mkdirSync(
        dirname(
          target,
        ),
        {
          recursive: true,
        },
      );

      copyFileSync(
        source,
        target,
      );

      console.log(
        `  COPY   ${change.path}`,
      );
    }
  }
}

function verifyCombinedTree({
  integrationPath,
  changes,
}) {
  const actual =
    readStatusEntries({
      worktreePath:
        integrationPath,

      role:
        'integration',
    })
      .map(
        (entry) =>
          entry.path,
      )
      .sort();

  const expected =
    changes
      .map(
        (change) =>
          change.path,
      )
      .sort();

  if (
    JSON.stringify(
      actual,
    ) !==
    JSON.stringify(
      expected,
    )
  ) {
    throw new Error(
      'Combined integration tree does not exactly match the audited worker change set.',
    );
  }

  let diffStat = '';

  try {
    execFileSync(
      'git',
      [
        'add',
        '--intent-to-add',
        '--',
        '.',
      ],
      {
        cwd:
          integrationPath,

        stdio:
          'ignore',
      },
    );

    execFileSync(
      'git',
      [
        'diff',
        '--check',
      ],
      {
        cwd:
          integrationPath,

        stdio:
          'inherit',
      },
    );

    diffStat =
      git(
        [
          'diff',
          '--stat',
        ],
        integrationPath,
      );
  } finally {
    execFileSync(
      'git',
      [
        'reset',
        '--mixed',
        'HEAD',
        '--',
      ],
      {
        cwd:
          integrationPath,

        stdio:
          'ignore',
      },
    );
  }

  return diffStat;
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

function updateManifestPrepared({
  manifestPath,
  manifest,
  integrationPath,
  integrationBranch,
  changes,
}) {
  const now =
    new Date()
      .toISOString();

  manifest.status =
    'integration-prepared';

  manifest.updatedAt =
    now;

  manifest.integration = {
    preparedAt:
      now,

    branch:
      integrationBranch,

    path:
      integrationPath,

    baseCommit:
      manifest.baseCommit,

    integrationOrder:
      manifest.plan
        .integrationOrder,

    changedPaths:
      changes.map(
        (change) => ({
          role:
            change.role,

          path:
            change.path,

          operation:
            change.operation,

          sha256:
            change.operation ===
            'copy'
              ? sha256File(
                  join(
                    integrationPath,
                    change.path,
                  ),
                )
              : null,
        }),
      ),
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
}

export function runControlledIntegration({
  repoRoot,
  sessionId,
}) {
  requireCleanRepo(
    repoRoot,
  );

  const branch =
    requireSafeBranch(
      repoRoot,
    );

  console.log('');
  console.log(
    'CONTROLLED INTEGRATION MODE',
  );
  console.log(
    '===========================',
  );

  console.log(
    `Branch: ${branch}`,
  );

  console.log(
    `Session: ${sessionId}`,
  );

  const {
    sessionsRoot,
    manifestPath,
  } =
    findSessionManifest({
      repoRoot,
      sessionId,
    });

  const manifest =
    validateManifest({
      repoRoot,
      sessionsRoot,
      manifestPath,
      sessionId,
    });

  console.log('');
  console.log(
    'SESSION MANIFEST: PASS',
  );

  console.log(
    `Base commit: ${manifest.baseCommit}`,
  );

  const changes =
    collectAuditedChanges(
      manifest,
    );

  console.log(
    'WORKER RE-AUDIT: PASS',
  );

  console.log(
    `Changed files: ${changes.length}`,
  );

  const {
    integrationPath,
    integrationBranch,
  } =
    createIntegrationWorktree({
      repoRoot,
      manifest,
    });

  console.log('');
  console.log(
    'INTEGRATION WORKTREE CREATED',
  );

  console.log(
    `  Branch: ${integrationBranch}`,
  );

  console.log(
    `  Path:   ${integrationPath}`,
  );

  applyChanges({
    manifest,
    changes,
    integrationPath,
  });

  const diffStat =
    verifyCombinedTree({
      integrationPath,
      changes,
    });

  updateManifestPrepared({
    manifestPath,
    manifest,
    integrationPath,
    integrationBranch,
    changes,
  });

  console.log('');
  console.log(
    'COMBINED TREE VALIDATION: PASS',
  );

  console.log('');

  if (diffStat) {
    console.log(
      diffStat,
    );
    console.log('');
  }

  console.log(
    '=================================',
  );
  console.log(
    'CONTROLLED INTEGRATION PREPARED',
  );
  console.log(
    '=================================',
  );

  console.log('');
  console.log(
    'No commit was created.',
  );

  console.log(
    'No push or merge occurred.',
  );

  console.log(
    'No database or migration execution occurred.',
  );

  console.log(
    'No deployment occurred.',
  );

  console.log('');
  console.log(
    'STOP: human inspection is required before any commit or merge.',
  );

  return {
    manifestPath,
    integrationPath,
    integrationBranch,
  };
}

async function runCli() {
  const sessionId =
    process.argv[2]
      ?.trim();

  if (
    !sessionId ||
    !/^\d{14}$/.test(
      sessionId,
    )
  ) {
    throw new Error(
      'Usage: node scripts/ai-integrate.mjs <14-digit-session-id>',
    );
  }

  if (
    process.argv.length !== 3
  ) {
    throw new Error(
      'Controlled integration accepts exactly one session ID.',
    );
  }

  runControlledIntegration({
    repoRoot:
      getRepoRoot(),

    sessionId,
  });
}

const directInvocation =
  process.argv[1]
    ? pathToFileURL(
        resolve(
          process.argv[1],
        ),
      ).href ===
      import.meta.url
    : false;

if (directInvocation) {
  runCli().catch(
    (error) => {
      console.error('');
      console.error(
        'Controlled integration failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
