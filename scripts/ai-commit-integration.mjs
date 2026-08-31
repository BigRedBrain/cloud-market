#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
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

function git(
  args,
  cwd,
  options = {},
) {
  return execFileSync(
    'git',
    args,
    {
      cwd,
      encoding:
        options.encoding ??
        'utf8',
      stdio:
        options.stdio ??
        [
          'ignore',
          'pipe',
          'pipe',
        ],
    },
  );
}

function getRepoRoot() {
  return resolve(
    git(
      [
        'rev-parse',
        '--show-toplevel',
      ],
      process.cwd(),
    ).trim(),
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
    ).trim();

  if (status) {
    throw new Error(
      'Orchestrator working tree must be clean before integration commit.',
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
    ).trim();

  if (
    !branch ||
    branch === 'main' ||
    branch === 'master'
  ) {
    throw new Error(
      'Integration commit must be launched from a non-main orchestrator branch.',
    );
  }

  return branch;
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
    normalized.startsWith('/') ||
    normalized.startsWith(':')
  ) {
    throw new Error(
      `Unsafe repository path: ${value}`,
    );
  }

  return normalized;
}

function sha256Buffer(
  value,
) {
  return createHash(
    'sha256',
  )
    .update(value)
    .digest('hex');
}

function sha256File(
  filePath,
) {
  return sha256Buffer(
    readFileSync(
      filePath,
    ),
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
          existsSync(
            candidate,
          ),
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
      `Multiple manifests found for ${sessionId}. Commit refused.`,
    );
  }

  return {
    sessionsRoot,
    manifestPath:
      matches[0],
  };
}

function validateManifest({
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
      'Unsupported manifest version.',
    );
  }

  if (
    manifest.sessionId !==
    sessionId
  ) {
    throw new Error(
      'Manifest session ID mismatch.',
    );
  }

  if (
    manifest.status !==
    'integration-prepared'
  ) {
    throw new Error(
      `Session is not commit-ready. Required status: integration-prepared. Current status: ${manifest.status ?? 'unknown'}.`,
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
      'Manifest worktree root is outside the allowed workspace.',
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
      'Manifest location does not match recorded worktree root.',
    );
  }

  const integration =
    manifest.integration;

  if (
    !integration ||
    typeof integration !==
      'object'
  ) {
    throw new Error(
      'Prepared integration metadata is missing.',
    );
  }

  const expectedPath =
    join(
      manifest.worktreeRoot,
      'integration',
    );

  if (
    resolve(
      integration.path ?? '',
    ) !==
    resolve(
      expectedPath,
    )
  ) {
    throw new Error(
      'Integration worktree path does not match session layout.',
    );
  }

  if (
    !existsSync(
      integration.path,
    )
  ) {
    throw new Error(
      'Integration worktree is missing.',
    );
  }

  if (
    integration.branch !==
    `ai/integrate-${sessionId}`
  ) {
    throw new Error(
      'Integration branch name does not match the session.',
    );
  }

  if (
    integration.baseCommit !==
    manifest.baseCommit
  ) {
    throw new Error(
      'Integration base commit does not match the manifest.',
    );
  }

  if (
    !Array.isArray(
      integration.changedPaths,
    ) ||
    integration.changedPaths.length ===
      0
  ) {
    throw new Error(
      'Prepared changed-path fingerprints are missing.',
    );
  }

  if (
    manifest.plan
      ?.sharedFiles
      ?.length
  ) {
    throw new Error(
      'Automatic commit refuses sessions containing shared/integration-only files.',
    );
  }

  const seen =
    new Set();

  for (
    const change
    of integration.changedPaths
  ) {
    const path =
      normalizeRepoPath(
        change.path,
      );

    if (
      seen.has(path)
    ) {
      throw new Error(
        `Duplicate prepared path: ${path}`,
      );
    }

    seen.add(path);

    if (
      change.operation !==
        'copy' &&
      change.operation !==
        'delete'
    ) {
      throw new Error(
        `Unsupported prepared operation for ${path}.`,
      );
    }

    if (
      change.operation ===
      'copy'
    ) {
      if (
        typeof change.sha256 !==
          'string' ||
        !/^[0-9a-f]{64}$/i.test(
          change.sha256,
        )
      ) {
        throw new Error(
          `Missing or invalid SHA-256 fingerprint for ${path}.`,
        );
      }
    }
  }

  return manifest;
}

function parseStatus(
  integrationPath,
) {
  const output =
    git(
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ],
      integrationPath,
    );

  const records =
    output
      .split('\0')
      .filter(Boolean);

  const changes = [];

  for (
    const record
    of records
  ) {
    if (
      record.length < 4
    ) {
      throw new Error(
        'Malformed Git status record.',
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
        'Prepared integration contains a rename/copy Git operation.',
      );
    }

    if (
      status.includes('U') ||
      [
        'AA',
        'DD',
        'AU',
        'UA',
        'DU',
        'UD',
      ].includes(status)
    ) {
      throw new Error(
        'Prepared integration contains an unresolved conflict.',
      );
    }

    const path =
      normalizeRepoPath(
        record.slice(3),
      );

    changes.push({
      status,
      path,
      operation:
        status.includes('D')
          ? 'delete'
          : 'copy',
    });
  }

  return changes;
}

function requireIndexClean(
  integrationPath,
) {
  const staged =
    git(
      [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        'HEAD',
      ],
      integrationPath,
    );

  if (staged.length) {
    throw new Error(
      'Integration worktree already contains staged changes. Commit refused.',
    );
  }
}

function verifyPreparedTree({
  manifest,
}) {
  const {
    path:
      integrationPath,
    branch:
      integrationBranch,
    changedPaths:
      expectedChanges,
  } =
    manifest.integration;

  const branch =
    git(
      [
        'branch',
        '--show-current',
      ],
      integrationPath,
    ).trim();

  if (
    branch !==
    integrationBranch
  ) {
    throw new Error(
      'Integration worktree is on the wrong branch.',
    );
  }

  const head =
    git(
      [
        'rev-parse',
        'HEAD',
      ],
      integrationPath,
    ).trim();

  if (
    head !==
    manifest.baseCommit
  ) {
    throw new Error(
      'Integration HEAD no longer equals the recorded base commit.',
    );
  }

  requireIndexClean(
    integrationPath,
  );

  const actualChanges =
    parseStatus(
      integrationPath,
    );

  const expectedMap =
    new Map(
      expectedChanges.map(
        (change) => [
          normalizeRepoPath(
            change.path,
          ),
          change,
        ],
      ),
    );

  if (
    actualChanges.length !==
    expectedMap.size
  ) {
    throw new Error(
      'Integration changed-path count no longer matches the prepared manifest.',
    );
  }

  for (
    const actual
    of actualChanges
  ) {
    const expected =
      expectedMap.get(
        actual.path,
      );

    if (!expected) {
      throw new Error(
        `Unexpected integration change: ${actual.path}`,
      );
    }

    if (
      actual.operation !==
      expected.operation
    ) {
      throw new Error(
        `Operation changed after preparation: ${actual.path}`,
      );
    }

    const fullPath =
      join(
        integrationPath,
        actual.path,
      );

    if (
      !pathIsInside(
        integrationPath,
        fullPath,
      )
    ) {
      throw new Error(
        `Unsafe integration path: ${actual.path}`,
      );
    }

    if (
      expected.operation ===
      'copy'
    ) {
      if (
        !existsSync(
          fullPath,
        )
      ) {
        throw new Error(
          `Prepared file disappeared: ${actual.path}`,
        );
      }

      const actualHash =
        sha256File(
          fullPath,
        );

      if (
        actualHash.toLowerCase() !==
        expected.sha256.toLowerCase()
      ) {
        throw new Error(
          `Prepared file fingerprint changed: ${actual.path}`,
        );
      }
    } else if (
      existsSync(
        fullPath,
      )
    ) {
      throw new Error(
        `Prepared deletion is no longer deleted: ${actual.path}`,
      );
    }
  }

  return {
    integrationPath,
    integrationBranch,
    expectedChanges,
  };
}

function stagePreparedPaths({
  integrationPath,
  expectedChanges,
}) {
  const paths =
    expectedChanges.map(
      (change) =>
        normalizeRepoPath(
          change.path,
        ),
    );

  execFileSync(
    'git',
    [
      'add',
      '--',
      ...paths,
    ],
    {
      cwd:
        integrationPath,
      stdio:
        'inherit',
    },
  );

  return paths;
}

function verifyStagedTree({
  integrationPath,
  expectedChanges,
}) {
  const expectedPaths =
    expectedChanges
      .map(
        (change) =>
          normalizeRepoPath(
            change.path,
          ),
      )
      .sort();

  const stagedPaths =
    git(
      [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        'HEAD',
      ],
      integrationPath,
    )
      .split('\0')
      .filter(Boolean)
      .map(
        normalizeRepoPath,
      )
      .sort();

  if (
    JSON.stringify(
      stagedPaths,
    ) !==
    JSON.stringify(
      expectedPaths,
    )
  ) {
    throw new Error(
      'Staged path set does not exactly match the prepared manifest.',
    );
  }

  const unstaged =
    git(
      [
        'diff',
        '--name-only',
        '-z',
      ],
      integrationPath,
    );

  if (unstaged.length) {
    throw new Error(
      'Integration worktree changed during staging. Commit refused.',
    );
  }

  for (
    const change
    of expectedChanges
  ) {
    const path =
      normalizeRepoPath(
        change.path,
      );

    if (
      change.operation ===
      'copy'
    ) {
      let stagedBytes;

      try {
        stagedBytes =
          git(
            [
              'show',
              `:${path}`,
            ],
            integrationPath,
            {
              encoding: null,
            },
          );
      } catch {
        throw new Error(
          `Unable to read staged file: ${path}`,
        );
      }

      const stagedHash =
        sha256Buffer(
          stagedBytes,
        );

      if (
        stagedHash.toLowerCase() !==
        change.sha256.toLowerCase()
      ) {
        throw new Error(
          `Staged fingerprint mismatch: ${path}`,
        );
      }
    } else {
      try {
        git(
          [
            'show',
            `:${path}`,
          ],
          integrationPath,
          {
            encoding: null,
          },
        );

        throw new Error(
          `Deleted path still exists in the index: ${path}`,
        );
      } catch (error) {
        if (
          error?.message?.startsWith(
            'Deleted path still exists'
          )
        ) {
          throw error;
        }
      }
    }
  }

  execFileSync(
    'git',
    [
      'diff',
      '--cached',
      '--check',
    ],
    {
      cwd:
        integrationPath,
      stdio:
        'inherit',
    },
  );
}

function unstagePreparedPaths({
  integrationPath,
  paths,
}) {
  if (
    !paths?.length
  ) {
    return;
  }

  try {
    execFileSync(
      'git',
      [
        'reset',
        '--mixed',
        'HEAD',
        '--',
        ...paths,
      ],
      {
        cwd:
          integrationPath,
        stdio:
          'ignore',
      },
    );
  } catch {
    // Preserve original failure.
  }
}

function createIntegrationCommit({
  manifest,
  integrationPath,
}) {
  const message =
    `AI integration ${manifest.sessionId}`;

  execFileSync(
    'git',
    [
      'commit',
      '-m',
      message,
    ],
    {
      cwd:
        integrationPath,
      stdio:
        'inherit',
    },
  );

  return git(
    [
      'rev-parse',
      'HEAD',
    ],
    integrationPath,
  ).trim();
}

function verifyCreatedCommit({
  manifest,
  integrationPath,
  commit,
}) {
  const parent =
    git(
      [
        'rev-parse',
        `${commit}^`,
      ],
      integrationPath,
    ).trim();

  if (
    parent !==
    manifest.baseCommit
  ) {
    throw new Error(
      'Created integration commit does not have the expected base parent.',
    );
  }

  const expectedPaths =
    manifest.integration
      .changedPaths
      .map(
        (change) =>
          normalizeRepoPath(
            change.path,
          ),
      )
      .sort();

  const committedPaths =
    git(
      [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        commit,
      ],
      integrationPath,
    )
      .split('\0')
      .filter(Boolean)
      .map(
        normalizeRepoPath,
      )
      .sort();

  if (
    JSON.stringify(
      committedPaths,
    ) !==
    JSON.stringify(
      expectedPaths,
    )
  ) {
    throw new Error(
      'Created commit path set does not match the prepared manifest.',
    );
  }

  const remainingStatus =
    git(
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ],
      integrationPath,
    ).trim();

  if (remainingStatus) {
    throw new Error(
      'Integration worktree is not clean after commit.',
    );
  }
}

function updateManifestCommitted({
  manifestPath,
  manifest,
  commit,
}) {
  const now =
    new Date()
      .toISOString();

  manifest.status =
    'integration-committed';

  manifest.updatedAt =
    now;

  manifest.integration.committedAt =
    now;

  manifest.integration.commit =
    commit;

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

export function runCommitIntegration({
  repoRoot,
  sessionId,
}) {
  requireCleanRepo(
    repoRoot,
  );

  const orchestratorBranch =
    requireSafeBranch(
      repoRoot,
    );

  console.log('');
  console.log(
    'HUMAN-APPROVED INTEGRATION COMMIT',
  );

  console.log(
    '=================================',
  );

  console.log(
    `Branch: ${orchestratorBranch}`,
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
      sessionsRoot,
      manifestPath,
      sessionId,
    });

  console.log('');
  console.log(
    'PREPARED MANIFEST: PASS',
  );

  const {
    integrationPath,
    integrationBranch,
    expectedChanges,
  } =
    verifyPreparedTree({
      manifest,
    });

  console.log(
    'PRE-COMMIT FINGERPRINT AUDIT: PASS',
  );

  console.log(
    `Prepared files: ${expectedChanges.length}`,
  );

  let stagedPaths = [];
  let commitCreated = false;

  try {
    stagedPaths =
      stagePreparedPaths({
        integrationPath,
        expectedChanges,
      });

    verifyStagedTree({
      integrationPath,
      expectedChanges,
    });

    console.log(
      'STAGED TREE AUDIT: PASS',
    );

    const commit =
      createIntegrationCommit({
        manifest,
        integrationPath,
      });

    commitCreated = true;

    verifyCreatedCommit({
      manifest,
      integrationPath,
      commit,
    });

    updateManifestCommitted({
      manifestPath,
      manifest,
      commit,
    });

    console.log('');
    console.log(
      '=================================',
    );

    console.log(
      'INTEGRATION COMMIT CREATED',
    );

    console.log(
      '=================================',
    );

    console.log(
      `Branch: ${integrationBranch}`,
    );

    console.log(
      `Commit: ${commit}`,
    );

    console.log('');
    console.log(
      'Manifest status: integration-committed',
    );

    console.log('');
    console.log(
      'No push occurred.',
    );

    console.log(
      'No merge occurred.',
    );

    console.log(
      'No database or migration execution occurred.',
    );

    console.log(
      'No deployment occurred.',
    );

    console.log('');
    console.log(
      'STOP: human inspection is required before any push or merge.',
    );

    return {
      manifestPath,
      integrationPath,
      integrationBranch,
      commit,
    };
  } catch (error) {
    if (
      !commitCreated
    ) {
      unstagePreparedPaths({
        integrationPath,
        paths:
          stagedPaths,
      });
    }

    throw error;
  }
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
      'Usage: node scripts/ai-commit-integration.mjs <14-digit-session-id>',
    );
  }

  if (
    process.argv.length !== 3
  ) {
    throw new Error(
      'Integration commit accepts exactly one session ID.',
    );
  }

  runCommitIntegration({
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
        'Integration commit failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
