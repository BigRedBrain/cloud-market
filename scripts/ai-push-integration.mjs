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

const REMOTE = 'origin';

function gitText(args, cwd) {
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
  );
}

function gitTrim(args, cwd) {
  return gitText(
    args,
    cwd,
  ).trim();
}

function gitBuffer(args, cwd) {
  return execFileSync(
    'git',
    args,
    {
      cwd,
      encoding: null,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  );
}

function getRepoRoot() {
  return resolve(
    gitTrim(
      [
        'rev-parse',
        '--show-toplevel',
      ],
      process.cwd(),
    ),
  );
}

function requireCleanOrchestrator(
  repoRoot,
) {
  const status =
    gitTrim(
      [
        'status',
        '--porcelain',
      ],
      repoRoot,
    );

  if (status) {
    throw new Error(
      'Orchestrator working tree must be clean before integration push.',
    );
  }
}

function requireSafeOrchestratorBranch(
  repoRoot,
) {
  const branch =
    gitTrim(
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
      'Integration push must be launched from a non-main orchestrator branch.',
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
    normalized.startsWith('/')
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
      `Multiple manifests found for ${sessionId}. Push refused.`,
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
    'integration-committed'
  ) {
    throw new Error(
      `Session is not push-ready. Required status: integration-committed. Current status: ${manifest.status ?? 'unknown'}.`,
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
      'Manifest location does not match its recorded worktree root.',
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
      'Integration metadata is missing.',
    );
  }

  if (
    integration.branch !==
    `ai/integrate-${sessionId}`
  ) {
    throw new Error(
      'Integration branch does not match the session.',
    );
  }

  if (
    integration.branch ===
      'main' ||
    integration.branch ===
      'master'
  ) {
    throw new Error(
      'Refusing to push a protected main branch.',
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
      'Integration worktree path does not match the session.',
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
    typeof integration.commit !==
      'string' ||
    !/^[0-9a-f]{40,64}$/i.test(
      integration.commit,
    )
  ) {
    throw new Error(
      'Recorded integration commit is invalid.',
    );
  }

  if (
    integration.baseCommit !==
    manifest.baseCommit
  ) {
    throw new Error(
      'Recorded integration base commit does not match the manifest.',
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
      'Committed changed-path fingerprints are missing.',
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
        `Duplicate committed path: ${path}`,
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
        `Unsupported committed operation: ${path}`,
      );
    }

    if (
      change.operation ===
      'copy' &&
      (
        typeof change.sha256 !==
          'string' ||
        !/^[0-9a-f]{64}$/i.test(
          change.sha256,
        )
      )
    ) {
      throw new Error(
        `Missing or invalid committed fingerprint: ${path}`,
      );
    }
  }

  return manifest;
}

function verifyCommittedIntegration(
  manifest,
) {
  const integration =
    manifest.integration;

  const integrationPath =
    integration.path;

  const branch =
    gitTrim(
      [
        'branch',
        '--show-current',
      ],
      integrationPath,
    );

  if (
    branch !==
    integration.branch
  ) {
    throw new Error(
      'Integration worktree is on the wrong branch.',
    );
  }

  const status =
    gitTrim(
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ],
      integrationPath,
    );

  if (status) {
    throw new Error(
      'Integration worktree is not clean.',
    );
  }

  const head =
    gitTrim(
      [
        'rev-parse',
        'HEAD',
      ],
      integrationPath,
    );

  if (
    head !==
    integration.commit
  ) {
    throw new Error(
      'Integration HEAD does not match the recorded integration commit.',
    );
  }

  const parentLine =
    gitTrim(
      [
        'rev-list',
        '--parents',
        '-n',
        '1',
        integration.commit,
      ],
      integrationPath,
    );

  const parentParts =
    parentLine
      .split(/\s+/)
      .filter(Boolean);

  if (
    parentParts.length !== 2
  ) {
    throw new Error(
      'Integration commit must have exactly one parent.',
    );
  }

  if (
    parentParts[1] !==
    manifest.baseCommit
  ) {
    throw new Error(
      'Integration commit parent does not match the recorded base commit.',
    );
  }

  const expectedPaths =
    integration.changedPaths
      .map(
        (change) =>
          normalizeRepoPath(
            change.path,
          ),
      )
      .sort();

  const committedPaths =
    gitText(
      [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        integration.commit,
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
      'Committed path set does not match the manifest.',
    );
  }

  for (
    const change
    of integration.changedPaths
  ) {
    const path =
      normalizeRepoPath(
        change.path,
      );

    if (
      change.operation ===
      'copy'
    ) {
      let bytes;

      try {
        bytes =
          gitBuffer(
            [
              'show',
              `${integration.commit}:${path}`,
            ],
            integrationPath,
          );
      } catch {
        throw new Error(
          `Unable to read committed file: ${path}`,
        );
      }

      const actualHash =
        sha256Buffer(
          bytes,
        );

      if (
        actualHash.toLowerCase() !==
        change.sha256.toLowerCase()
      ) {
        throw new Error(
          `Committed fingerprint mismatch: ${path}`,
        );
      }
    } else {
      let existsInCommit =
        true;

      try {
        execFileSync(
          'git',
          [
            'cat-file',
            '-e',
            `${integration.commit}:${path}`,
          ],
          {
            cwd:
              integrationPath,
            stdio:
              'ignore',
          },
        );
      } catch {
        existsInCommit =
          false;
      }

      if (existsInCommit) {
        throw new Error(
          `Committed deletion is not deleted: ${path}`,
        );
      }
    }
  }

  return {
    integrationPath,
    integrationBranch:
      integration.branch,
    commit:
      integration.commit,
  };
}

function verifyRemotePreflight({
  integrationPath,
  integrationBranch,
}) {
  // Confirm origin exists, but do not print its URL because
  // a locally configured URL could contain credentials.
  try {
    gitTrim(
      [
        'remote',
        'get-url',
        REMOTE,
      ],
      integrationPath,
    );
  } catch {
    throw new Error(
      `Required Git remote "${REMOTE}" is not configured.`,
    );
  }

  let remoteHeads;

  try {
    remoteHeads =
      gitTrim(
        [
          'ls-remote',
          '--heads',
          REMOTE,
          `refs/heads/${integrationBranch}`,
        ],
        integrationPath,
      );
  } catch {
    throw new Error(
      `Unable to read remote "${REMOTE}". Push preflight failed.`,
    );
  }

  if (remoteHeads) {
    throw new Error(
      `Remote branch already exists: ${REMOTE}/${integrationBranch}. Push refused.`,
    );
  }
}

function pushExactCommit({
  integrationPath,
  integrationBranch,
  commit,
}) {
  execFileSync(
    'git',
    [
      'push',
      '--porcelain',
      REMOTE,
      `${commit}:refs/heads/${integrationBranch}`,
    ],
    {
      cwd:
        integrationPath,
      stdio:
        'inherit',
    },
  );

  const remoteResult =
    gitTrim(
      [
        'ls-remote',
        '--heads',
        REMOTE,
        `refs/heads/${integrationBranch}`,
      ],
      integrationPath,
    );

  const fields =
    remoteResult
      .split(/\s+/)
      .filter(Boolean);

  if (
    fields.length < 2 ||
    fields[0] !== commit ||
    fields[1] !==
      `refs/heads/${integrationBranch}`
  ) {
    throw new Error(
      'Remote verification failed after push. Inspect the remote manually.',
    );
  }
}

function updateManifestPushed({
  manifestPath,
  manifest,
}) {
  const now =
    new Date()
      .toISOString();

  manifest.status =
    'integration-pushed';

  manifest.updatedAt =
    now;

  manifest.integration.pushedAt =
    now;

  manifest.integration.remote =
    REMOTE;

  manifest.integration.remoteBranch =
    manifest.integration.branch;

  manifest.integration.remoteCommit =
    manifest.integration.commit;

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

export function runPushIntegration({
  repoRoot,
  sessionId,
  checkOnly = false,
}) {
  requireCleanOrchestrator(
    repoRoot,
  );

  const orchestratorBranch =
    requireSafeOrchestratorBranch(
      repoRoot,
    );

  console.log('');
  console.log(
    checkOnly
      ? 'INTEGRATION PUSH PREFLIGHT'
      : 'HUMAN-APPROVED INTEGRATION PUSH',
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
    'COMMITTED MANIFEST: PASS',
  );

  const {
    integrationPath,
    integrationBranch,
    commit,
  } =
    verifyCommittedIntegration(
      manifest,
    );

  console.log(
    'COMMITTED TREE AUDIT: PASS',
  );

  console.log(
    `Commit: ${commit}`,
  );

  verifyRemotePreflight({
    integrationPath,
    integrationBranch,
  });

  console.log(
    'REMOTE PREFLIGHT: PASS',
  );

  console.log(
    `Target: ${REMOTE}/${integrationBranch}`,
  );

  if (checkOnly) {
    console.log('');
    console.log(
      'PUSH PREFLIGHT COMPLETE',
    );

    console.log(
      'No push occurred.',
    );

    console.log(
      'No merge occurred.',
    );

    console.log(
      'No local deployment or database command was executed.',
    );

    return {
      manifestPath,
      integrationPath,
      integrationBranch,
      commit,
    };
  }

  console.log('');
  console.log(
    'Pushing exact approved commit...',
  );

  pushExactCommit({
    integrationPath,
    integrationBranch,
    commit,
  });

  updateManifestPushed({
    manifestPath,
    manifest,
  });

  console.log('');
  console.log(
    '=================================',
  );

  console.log(
    'INTEGRATION BRANCH PUSHED',
  );

  console.log(
    '=================================',
  );

  console.log(
    `Remote: ${REMOTE}`,
  );

  console.log(
    `Branch: ${integrationBranch}`,
  );

  console.log(
    `Commit: ${commit}`,
  );

  console.log('');
  console.log(
    'Manifest status: integration-pushed',
  );

  console.log('');
  console.log(
    'No merge occurred.',
  );

  console.log(
    'No local deployment or database command was executed.',
  );

  console.log('');
  console.log(
    'NOTE: remote CI/CD or hosting integrations may react to a branch push.',
  );

  console.log('');
  console.log(
    'STOP: human review is required before opening or merging a pull request.',
  );

  return {
    manifestPath,
    integrationPath,
    integrationBranch,
    commit,
  };
}

async function runCli() {
  const args =
    process.argv.slice(2);

  let checkOnly =
    false;

  let sessionId =
    null;

  if (
    args[0] === '--check'
  ) {
    checkOnly =
      true;

    sessionId =
      args[1]?.trim();

    if (
      args.length !== 2
    ) {
      throw new Error(
        'Usage: node scripts/ai-push-integration.mjs --check <14-digit-session-id>',
      );
    }
  } else {
    sessionId =
      args[0]?.trim();

    if (
      args.length !== 1
    ) {
      throw new Error(
        'Usage: node scripts/ai-push-integration.mjs <14-digit-session-id>',
      );
    }
  }

  if (
    !sessionId ||
    !/^\d{14}$/.test(
      sessionId,
    )
  ) {
    throw new Error(
      'Integration push requires a 14-digit session ID.',
    );
  }

  runPushIntegration({
    repoRoot:
      getRepoRoot(),

    sessionId,
    checkOnly,
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
        'Integration push failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
