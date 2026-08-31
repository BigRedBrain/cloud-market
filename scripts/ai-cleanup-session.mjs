#!/usr/bin/env node

import {
  createHash,
} from 'node:crypto';

import {
  existsSync,
  lstatSync,
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
  sep,
} from 'node:path';

import {
  execFileSync,
} from 'node:child_process';

import {
  pathToFileURL,
} from 'node:url';

function commandText(
  command,
  args,
  cwd,
) {
  return execFileSync(
    command,
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
    commandText(
      'git',
      [
        'rev-parse',
        '--show-toplevel',
      ],
      process.cwd(),
    ),
  );
}

function samePath(
  left,
  right,
) {
  return (
    resolve(left)
      .toLowerCase() ===
    resolve(right)
      .toLowerCase()
  );
}

function assertInside(
  parent,
  child,
  label,
) {
  const parentPath =
    resolve(parent);

  const childPath =
    resolve(child);

  const rel =
    relative(
      parentPath,
      childPath,
    );

  if (
    !rel ||
    rel === '.'
  ) {
    return;
  }

  if (
    rel === '..' ||
    rel.startsWith(
      `..${sep}`,
    ) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `${label} escapes the approved session directory.`,
    );
  }
}

function normalizeGitPath(
  value,
) {
  const normalized =
    String(value)
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '');

  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(
      `Unsafe relative path in manifest: ${value}`,
    );
  }

  return normalized;
}

function exactSetMatch(
  actual,
  expected,
) {
  if (
    actual.size !==
    expected.size
  ) {
    return false;
  }

  for (
    const value
    of actual
  ) {
    if (
      !expected.has(value)
    ) {
      return false;
    }
  }

  return true;
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
    .digest('hex');
}

function findManifest({
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
      'AI worktree root does not exist.',
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
        (entry) => ({
          root:
            resolve(
              sessionsRoot,
              entry.name,
            ),

          manifest:
            resolve(
              sessionsRoot,
              entry.name,
              'ai-session-manifest.json',
            ),
        }),
      )
      .filter(
        (candidate) =>
          existsSync(
            candidate.manifest,
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
      `Multiple session manifests found for ${sessionId}.`,
    );
  }

  return {
    sessionsRoot,
    sessionRoot:
      matches[0].root,

    manifestPath:
      matches[0].manifest,
  };
}

function readManifest(
  manifestPath,
) {
  try {
    return JSON.parse(
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
}

function assertGitWorktree(
  worktreePath,
  label,
) {
  if (
    !existsSync(
      worktreePath,
    )
  ) {
    throw new Error(
      `${label} worktree is missing: ${worktreePath}`,
    );
  }

  let topLevel;

  try {
    topLevel =
      commandText(
        'git',
        [
          'rev-parse',
          '--show-toplevel',
        ],
        worktreePath,
      );
  } catch {
    throw new Error(
      `${label} path is not a valid Git worktree.`,
    );
  }

  if (
    !samePath(
      topLevel,
      worktreePath,
    )
  ) {
    throw new Error(
      `${label} Git root does not match its recorded worktree path.`,
    );
  }
}

function readStatusEntries(
  worktreePath,
) {
  const raw =
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

  if (!raw) {
    return [];
  }

  const records =
    raw.split('\0');

  const entries = [];

  for (
    let index = 0;
    index < records.length;
    index += 1
  ) {
    const record =
      records[index];

    if (!record) {
      continue;
    }

    if (
      record.length < 4
    ) {
      throw new Error(
        'Unexpected Git status record.',
      );
    }

    const x =
      record[0];

    const y =
      record[1];

    const path =
      normalizeGitPath(
        record.slice(3),
      );

    const renameOrCopy =
      x === 'R' ||
      x === 'C' ||
      y === 'R' ||
      y === 'C';

    if (renameOrCopy) {
      // Porcelain -z emits the second path
      // as the following NUL-separated record.
      index += 1;

      throw new Error(
        `Rename/copy detected in worktree: ${path}`,
      );
    }

    entries.push({
      x,
      y,
      path,
    });
  }

  return entries;
}

function assertWorker({
  worker,
  manifest,
  sessionRoot,
}) {
  const role =
    worker.role;

  const approvedRoles =
    new Set([
      'frontend',
      'backend',
      'database',
    ]);

  if (
    !approvedRoles.has(role)
  ) {
    throw new Error(
      `Unexpected worker role: ${role}`,
    );
  }

  assertInside(
    sessionRoot,
    worker.path,
    `${role} worker`,
  );

  assertGitWorktree(
    worker.path,
    role,
  );

  const branch =
    commandText(
      'git',
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
      `${role} worker branch mismatch.`,
    );
  }

  const head =
    commandText(
      'git',
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
      `${role} worker HEAD no longer matches the session base commit.`,
    );
  }

  const statusEntries =
    readStatusEntries(
      worker.path,
    );

  for (
    const entry
    of statusEntries
  ) {
    // Preserve anything someone explicitly
    // staged after the worker run.
    if (
      entry.x !== ' ' &&
      entry.x !== '?'
    ) {
      throw new Error(
        `${role} worker contains staged changes. Cleanup refused: ${entry.path}`,
      );
    }
  }

  const integrationEntries =
    (
      manifest.integration
        ?.changedPaths ??
      []
    )
      .filter(
        (entry) =>
          entry.role ===
          role,
      );

  const expectedPaths =
    new Set(
      integrationEntries.map(
        (entry) =>
          normalizeGitPath(
            entry.path,
          ),
      ),
    );

  const actualPaths =
    new Set(
      statusEntries.map(
        (entry) =>
          entry.path,
      ),
    );

  if (
    !exactSetMatch(
      actualPaths,
      expectedPaths,
    )
  ) {
    throw new Error(
      `${role} worker changed paths no longer exactly match the audited integration paths.`,
    );
  }

  const ownedPaths =
    new Set(
      (
        manifest.plan
          ?.[role]
          ?.ownedPaths ??
        []
      ).map(
        normalizeGitPath,
      ),
    );

  for (
    const expectedPath
    of expectedPaths
  ) {
    if (
      !ownedPaths.has(
        expectedPath,
      )
    ) {
      throw new Error(
        `${role} integration path is outside the worker's recorded ownership: ${expectedPath}`,
      );
    }
  }

  for (
    const entry
    of integrationEntries
  ) {
    const relativePath =
      normalizeGitPath(
        entry.path,
      );

    const fullPath =
      resolve(
        worker.path,
        relativePath,
      );

    assertInside(
      worker.path,
      fullPath,
      `${role} changed file`,
    );

    if (
      entry.operation ===
      'copy'
    ) {
      if (
        !existsSync(
          fullPath,
        )
      ) {
        throw new Error(
          `${role} expected file is missing: ${relativePath}`,
        );
      }

      const stat =
        lstatSync(
          fullPath,
        );

      if (
        !stat.isFile() ||
        stat.isSymbolicLink()
      ) {
        throw new Error(
          `${role} expected path is not a regular file: ${relativePath}`,
        );
      }

      if (
        !/^[a-f0-9]{64}$/.test(
          entry.sha256 ?? '',
        )
      ) {
        throw new Error(
          `${role} manifest contains an invalid SHA-256 for ${relativePath}.`,
        );
      }

      const actualHash =
        sha256File(
          fullPath,
        );

      if (
        actualHash !==
        entry.sha256
      ) {
        throw new Error(
          `${role} worker file hash no longer matches the audited integration hash: ${relativePath}`,
        );
      }
    } else if (
      entry.operation ===
      'delete'
    ) {
      if (
        existsSync(
          fullPath,
        )
      ) {
        throw new Error(
          `${role} expected deletion is no longer deleted: ${relativePath}`,
        );
      }
    } else {
      throw new Error(
        `${role} has an unsupported integration operation: ${entry.operation}`,
      );
    }
  }

  return {
    role,
    branch,
    head,
    changedPaths:
      [...actualPaths],
  };
}

function assertIntegration({
  manifest,
  sessionRoot,
}) {
  const integration =
    manifest.integration;

  if (!integration) {
    throw new Error(
      'Session has no integration record.',
    );
  }

  assertInside(
    sessionRoot,
    integration.path,
    'Integration worktree',
  );

  assertGitWorktree(
    integration.path,
    'Integration',
  );

  const branch =
    commandText(
      'git',
      [
        'branch',
        '--show-current',
      ],
      integration.path,
    );

  if (
    branch !==
    integration.branch
  ) {
    throw new Error(
      'Integration branch mismatch.',
    );
  }

  const head =
    commandText(
      'git',
      [
        'rev-parse',
        'HEAD',
      ],
      integration.path,
    );

  if (
    head !==
    integration.commit
  ) {
    throw new Error(
      'Integration HEAD does not match the recorded approved commit.',
    );
  }

  const statusEntries =
    readStatusEntries(
      integration.path,
    );

  if (
    statusEntries.length !==
    0
  ) {
    throw new Error(
      'Integration worktree is dirty. Cleanup refused.',
    );
  }

  return {
    branch,
    head,
  };
}

function assertRemoteBranchAbsent({
  manifest,
}) {
  const integration =
    manifest.integration;

  if (
    !integration.remote ||
    !integration.remoteBranch
  ) {
    throw new Error(
      'Manifest does not contain the recorded integration remote branch.',
    );
  }

  let output;

  try {
    output =
      commandText(
        'git',
        [
          'ls-remote',
          '--heads',
          integration.remote,
          `refs/heads/${integration.remoteBranch}`,
        ],
        integration.path,
      );
  } catch {
    throw new Error(
      'Could not verify remote integration branch state.',
    );
  }

  if (output) {
    throw new Error(
      `Remote integration branch still exists: ${integration.remote}/${integration.remoteBranch}`,
    );
  }
}

function assertPullRequestClosed({
  manifest,
}) {
  const pr =
    manifest.integration
      ?.pullRequest;

  if (
    !pr?.number ||
    !pr?.repository
  ) {
    throw new Error(
      'Session does not contain a recorded pull request.',
    );
  }

  let output;

  try {
    output =
      commandText(
        'gh',
        [
          'pr',
          'view',
          String(pr.number),
          '--repo',
          pr.repository,
          '--json',
          'number,state,url,baseRefName,headRefName,headRefOid',
        ],
        process.cwd(),
      );
  } catch {
    throw new Error(
      'Could not verify the live GitHub pull request state.',
    );
  }

  let livePr;

  try {
    livePr =
      JSON.parse(
        output,
      );
  } catch {
    throw new Error(
      'GitHub returned invalid pull request data.',
    );
  }

  if (
    livePr.number !==
    pr.number
  ) {
    throw new Error(
      'Pull request number mismatch.',
    );
  }

  if (
    livePr.baseRefName !==
    pr.baseBranch
  ) {
    throw new Error(
      'Pull request base branch mismatch.',
    );
  }

  if (
    livePr.headRefName !==
    pr.headBranch
  ) {
    throw new Error(
      'Pull request head branch mismatch.',
    );
  }

  if (
    livePr.headRefOid !==
    pr.commit
  ) {
    throw new Error(
      'Pull request commit no longer matches the approved integration commit.',
    );
  }

  if (
    livePr.state !== 'CLOSED' &&
    livePr.state !== 'MERGED'
  ) {
    throw new Error(
      `Pull request is still ${livePr.state}. Cleanup refused.`,
    );
  }

  return livePr;
}

function assertSessionRootContents({
  sessionRoot,
}) {
  const allowed =
    new Set([
      'frontend',
      'backend',
      'database',
      'integration',
      'ai-session-manifest.json',
    ]);

  const unexpected =
    readdirSync(
      sessionRoot,
      {
        withFileTypes: true,
      },
    )
      .map(
        (entry) =>
          entry.name,
      )
      .filter(
        (name) =>
          !allowed.has(name),
      );

  if (
    unexpected.length
  ) {
    throw new Error(
      `Unexpected session-root content exists: ${unexpected.join(', ')}`,
    );
  }
}

function assertOrchestratorClean(
  repoRoot,
) {
  const status =
    commandText(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ],
      repoRoot,
    );

  if (status) {
    throw new Error(
      'Orchestrator working tree must be clean before cleanup preflight.',
    );
  }
}

export function checkSessionCleanup({
  repoRoot,
  sessionId,
}) {
  console.log('');
  console.log(
    'SESSION CLEANUP PREFLIGHT',
  );
  console.log(
    '=========================',
  );
  console.log(
    `Session: ${sessionId}`,
  );
  console.log('');

  assertOrchestratorClean(
    repoRoot,
  );

  console.log(
    'ORCHESTRATOR TREE: PASS',
  );

  const {
    sessionRoot,
    manifestPath,
  } =
    findManifest({
      repoRoot,
      sessionId,
    });

  const manifest =
    readManifest(
      manifestPath,
    );

  if (
    manifest.manifestVersion !==
    1
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
      'Manifest session ID mismatch.',
    );
  }

  // Cleanup v1 intentionally handles only
  // sessions that reached the PR boundary.
  if (
    manifest.status !==
    'pr-opened'
  ) {
    throw new Error(
      `Cleanup v1 requires manifest status pr-opened. Current status: ${manifest.status}`,
    );
  }

  if (
    !/^[a-f0-9]{40}$/.test(
      manifest.baseCommit ?? '',
    )
  ) {
    throw new Error(
      'Manifest contains an invalid base commit.',
    );
  }

  console.log(
    'MANIFEST: PASS',
  );

  assertSessionRootContents({
    sessionRoot,
  });

  console.log(
    'SESSION ROOT CONTENTS: PASS',
  );

  const workers =
    manifest.workers ?? [];

  if (
    workers.length !==
    3
  ) {
    throw new Error(
      'Cleanup requires exactly three recorded workers.',
    );
  }

  const roles =
    workers
      .map(
        (worker) =>
          worker.role,
      )
      .sort();

  if (
    roles.join(',') !==
    'backend,database,frontend'
  ) {
    throw new Error(
      'Recorded worker roles are invalid.',
    );
  }

  for (
    const worker
    of workers
  ) {
    const result =
      assertWorker({
        worker,
        manifest,
        sessionRoot,
      });

    console.log(
      `${result.role.toUpperCase()} WORKTREE: PASS`,
    );
  }

  const integration =
    assertIntegration({
      manifest,
      sessionRoot,
    });

  console.log(
    'INTEGRATION WORKTREE: PASS',
  );

  assertRemoteBranchAbsent({
    manifest,
  });

  console.log(
    'REMOTE BRANCH ABSENT: PASS',
  );

  const livePr =
    assertPullRequestClosed({
      manifest,
  });

  console.log(
    `PULL REQUEST ${livePr.state}: PASS`,
  );

  console.log('');
  console.log(
    'CLEANUP PREFLIGHT PASSED',
  );
  console.log(
    '========================',
  );
  console.log(
    `Session root: ${sessionRoot}`,
  );
  console.log(
    `Integration branch: ${integration.branch}`,
  );
  console.log(
    `Integration commit: ${integration.head}`,
  );
  console.log(
    `PR: #${livePr.number} ${livePr.state}`,
  );

  console.log('');
  console.log(
    'No files, worktrees, branches, GitHub resources, deployments, or database state were changed.',
  );

  console.log(
    'This command performed verification only.',
  );

  return {
    sessionRoot,
    manifestPath,
    manifest,
    livePr,
  };
}


function commonGitDir(
  worktreePath,
) {
  const value =
    commandText(
      'git',
      [
        'rev-parse',
        '--git-common-dir',
      ],
      worktreePath,
    );

  return isAbsolute(value)
    ? resolve(value)
    : resolve(
        worktreePath,
        value,
      );
}

function getSessionRepositoryRoot(
  manifest,
) {
  const integrationPath =
    manifest.integration?.path;

  if (!integrationPath) {
    throw new Error(
      'Integration worktree path is missing.',
    );
  }

  const commonDir =
    commonGitDir(
      integrationPath,
    );

  const repositoryRoot =
    resolve(
      commonDir,
      '..',
    );

  const topLevel =
    commandText(
      'git',
      [
        'rev-parse',
        '--show-toplevel',
      ],
      repositoryRoot,
    );

  if (
    !samePath(
      topLevel,
      repositoryRoot,
    )
  ) {
    throw new Error(
      'Could not safely resolve the parent repository for cleanup.',
    );
  }

  const expectedCommonDir =
    commonGitDir(
      integrationPath,
    );

  for (
    const worker
    of manifest.workers ?? []
  ) {
    const workerCommonDir =
      commonGitDir(
        worker.path,
      );

    if (
      !samePath(
        workerCommonDir,
        expectedCommonDir,
      )
    ) {
      throw new Error(
        `${worker.role} worker belongs to a different Git repository.`,
      );
    }
  }

  return repositoryRoot;
}

function localBranchExists(
  repositoryRoot,
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
        cwd:
          repositoryRoot,

        stdio: [
          'ignore',
          'ignore',
          'ignore',
        ],
      },
    );

    return true;
  } catch {
    return false;
  }
}

function validateCleanupBranches({
  manifest,
  sessionId,
  repositoryRoot,
}) {
  const branches = [];

  for (
    const worker
    of manifest.workers ?? []
  ) {
    const branch =
      worker.branch;

    if (
      typeof branch !== 'string' ||
      !branch.startsWith('ai/') ||
      !branch.includes(sessionId) ||
      !branch.endsWith(
        `-${worker.role}`,
      )
    ) {
      throw new Error(
        `Unsafe worker branch name for cleanup: ${branch}`,
      );
    }

    branches.push(branch);
  }

  const integrationBranch =
    manifest.integration
      ?.branch;

  if (
    integrationBranch !==
    `ai/integrate-${sessionId}`
  ) {
    throw new Error(
      'Integration branch does not match the exact cleanup naming convention.',
    );
  }

  branches.push(
    integrationBranch,
  );

  if (
    new Set(branches).size !==
    branches.length
  ) {
    throw new Error(
      'Duplicate cleanup branches detected.',
    );
  }

  const currentBranch =
    commandText(
      'git',
      [
        'branch',
        '--show-current',
      ],
      repositoryRoot,
    );

  if (
    branches.includes(
      currentBranch,
    )
  ) {
    throw new Error(
      `Cleanup target branch is currently checked out in the parent repository: ${currentBranch}`,
    );
  }

  for (
    const branch
    of branches
  ) {
    if (
      !localBranchExists(
        repositoryRoot,
        branch,
      )
    ) {
      throw new Error(
        `Recorded local cleanup branch is missing: ${branch}`,
      );
    }
  }

  return branches;
}

function removeRecordedWorktree({
  repositoryRoot,
  worktreePath,
  label,
}) {
  execFileSync(
    'git',
    [
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ],
    {
      cwd:
        repositoryRoot,

      stdio:
        'inherit',
    },
  );

  if (
    existsSync(
      worktreePath,
    )
  ) {
    throw new Error(
      `${label} worktree still exists after Git removal.`,
    );
  }
}

function deleteRecordedBranch({
  repositoryRoot,
  branch,
}) {
  execFileSync(
    'git',
    [
      'branch',
      '-D',
      branch,
    ],
    {
      cwd:
        repositoryRoot,

      stdio:
        'inherit',
    },
  );

  if (
    localBranchExists(
      repositoryRoot,
      branch,
    )
  ) {
    throw new Error(
      `Local branch still exists after deletion: ${branch}`,
    );
  }
}

function writeCleanupState({
  manifestPath,
  manifest,
  cleanup,
}) {
  manifest.cleanup =
    cleanup;

  manifest.updatedAt =
    new Date()
      .toISOString();

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

export function executeSessionCleanup({
  repoRoot,
  sessionId,
}) {
  console.log('');
  console.log(
    'HUMAN-APPROVED SESSION CLEANUP',
  );
  console.log(
    '==============================',
  );
  console.log(
    `Session: ${sessionId}`,
  );
  console.log('');

  // Mandatory full preflight immediately
  // before any destructive operation.
  const checked =
    checkSessionCleanup({
      repoRoot,
      sessionId,
    });

  const {
    manifest,
    manifestPath,
    sessionRoot,
    livePr,
  } = checked;

  const repositoryRoot =
    getSessionRepositoryRoot(
      manifest,
    );

  const branches =
    validateCleanupBranches({
      manifest,
      sessionId,
      repositoryRoot,
    });

  console.log('');
  console.log(
    'DESTRUCTIVE CLEANUP PLAN',
  );
  console.log(
    '========================',
  );

  for (
    const worker
    of manifest.workers
  ) {
    console.log(
      `Remove worktree: ${worker.path}`,
    );
  }

  console.log(
    `Remove worktree: ${manifest.integration.path}`,
  );

  for (
    const branch
    of branches
  ) {
    console.log(
      `Delete local branch: ${branch}`,
    );
  }

  console.log('');
  console.log(
    'Remote branches will NOT be deleted.',
  );
  console.log(
    'GitHub pull requests will NOT be changed.',
  );
  console.log(
    'No merge, deployment, migration, or database command will run.',
  );
  console.log('');

  const removedWorktrees = [];
  const deletedBranches = [];

  const cleanup =
    {
      status:
        'in-progress',

      startedAt:
        new Date()
          .toISOString(),

      completedAt:
        null,

      pullRequest:
        {
          number:
            livePr.number,

          state:
            livePr.state,
        },

      remoteBranchDeleted:
        false,

      pullRequestChanged:
        false,

      removedWorktrees,

      deletedBranches,
    };

  // Record the attempt before deletion.
  writeCleanupState({
    manifestPath,
    manifest,
    cleanup,
  });

  try {
    for (
      const worker
      of manifest.workers
    ) {
      removeRecordedWorktree({
        repositoryRoot,
        worktreePath:
          worker.path,

        label:
          worker.role,
      });

      removedWorktrees.push({
        role:
          worker.role,

        path:
          worker.path,
      });

      writeCleanupState({
        manifestPath,
        manifest,
        cleanup,
      });
    }

    removeRecordedWorktree({
      repositoryRoot,
      worktreePath:
        manifest.integration.path,

      label:
        'integration',
    });

    removedWorktrees.push({
      role:
        'integration',

      path:
        manifest.integration.path,
    });

    writeCleanupState({
      manifestPath,
      manifest,
      cleanup,
    });

    // Remove stale administrative worktree
    // metadata, if any.
    execFileSync(
      'git',
      [
        'worktree',
        'prune',
      ],
      {
        cwd:
          repositoryRoot,

        stdio:
          'inherit',
      },
    );

    for (
      const branch
      of branches
    ) {
      deleteRecordedBranch({
        repositoryRoot,
        branch,
      });

      deletedBranches.push(
        branch,
      );

      writeCleanupState({
        manifestPath,
        manifest,
        cleanup,
      });
    }

    const remaining =
      readdirSync(
        sessionRoot,
        {
          withFileTypes: true,
        },
      )
        .map(
          (entry) =>
            entry.name,
        )
        .filter(
          (name) =>
            name !==
            'ai-session-manifest.json',
        );

    if (
      remaining.length
    ) {
      throw new Error(
        `Unexpected content remains after cleanup: ${remaining.join(', ')}`,
      );
    }

    cleanup.status =
      'complete';

    cleanup.completedAt =
      new Date()
        .toISOString();

    manifest.status =
      'cleaned';

    writeCleanupState({
      manifestPath,
      manifest,
      cleanup,
    });
  } catch (error) {
    cleanup.status =
      'failed';

    cleanup.failedAt =
      new Date()
        .toISOString();

    cleanup.error =
      error?.message ??
      String(error);

    try {
      writeCleanupState({
        manifestPath,
        manifest,
        cleanup,
      });
    } catch {
      // Preserve the original cleanup error.
    }

    throw error;
  }

  console.log('');
  console.log(
    'SESSION CLEANUP COMPLETE',
  );
  console.log(
    '========================',
  );
  console.log(
    `Session: ${sessionId}`,
  );
  console.log(
    `Worktrees removed: ${removedWorktrees.length}`,
  );
  console.log(
    `Local branches deleted: ${deletedBranches.length}`,
  );
  console.log(
    'Manifest status: cleaned',
  );

  console.log('');
  console.log(
    'No remote branch was deleted.',
  );
  console.log(
    'No pull request was changed.',
  );
  console.log(
    'No merge, deployment, migration, or database command was executed.',
  );

  return {
    sessionRoot,
    manifestPath,
    removedWorktrees,
    deletedBranches,
  };
}

async function runCli() {
  const args =
    process.argv.slice(2);

  if (
    args.length !== 2 ||
    (
      args[0] !== '--check' &&
      args[0] !== '--execute'
    ) ||
    !/^\d{14}$/.test(
      args[1] ?? '',
    )
  ) {
    throw new Error(
      'Usage: node scripts/ai-cleanup-session.mjs <--check|--execute> <14-digit-session-id>',
    );
  }

  const repoRoot =
    getRepoRoot();

  const sessionId =
    args[1];

  if (
    args[0] ===
    '--check'
  ) {
    checkSessionCleanup({
      repoRoot,
      sessionId,
    });

    return;
  }

  executeSessionCleanup({
    repoRoot,
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
        'Session cleanup failed:',
      );
      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
