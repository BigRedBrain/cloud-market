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

const REMOTE =
  'origin';

const EXPECTED_REPO =
  'BigRedBrain/cloud-market';

const DEFAULT_BRANCH =
  'main';

export function resolvePrBaseBranch(
  manifest,
) {
  const value =
    manifest?.targetBranch;

  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim()
  ) {
    throw new Error(
      'Session manifest does not contain a valid recorded targetBranch. Legacy sessions must be recreated or explicitly recovered; refusing to assume main.',
    );
  }

  if (
    value ===
    manifest?.integration?.branch
  ) {
    throw new Error(
      'Recorded PR base branch may not equal the integration branch.',
    );
  }

  return value;
}

export function validatePrComparison({
  manifest,
  comparison,
  baseBranch,
  commit,
}) {
  if (
    !comparison ||
    typeof comparison !== 'object'
  ) {
    throw new Error(
      'GitHub returned invalid PR-base comparison data.',
    );
  }

  if (
    comparison.merge_base_commit?.sha !==
    manifest.baseCommit
  ) {
    throw new Error(
      'PR base merge-base no longer matches the audited session base commit.',
    );
  }

  if (
    comparison.ahead_by !== 1 ||
    comparison.total_commits !== 1 ||
    !Number.isInteger(
      comparison.behind_by,
    ) ||
    comparison.behind_by < 0
  ) {
    throw new Error(
      'PR comparison is not exactly one approved head commit above the audited merge-base.',
    );
  }

  if (
    !Array.isArray(
      comparison.commits,
    ) ||
    comparison.commits.length !== 1 ||
    comparison.commits[0]?.sha !==
      commit
  ) {
    throw new Error(
      'PR comparison commit set does not equal the approved integration commit.',
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

  if (
    !Array.isArray(
      comparison.files,
    )
  ) {
    throw new Error(
      'GitHub comparison did not return a complete file list.',
    );
  }

  const actualPaths =
    comparison.files
      .map(
        (file) =>
          normalizeRepoPath(
            file.filename,
          ),
      )
      .sort();

  if (
    JSON.stringify(
      actualPaths,
    ) !==
    JSON.stringify(
      expectedPaths,
    )
  ) {
    throw new Error(
      'PR comparison path set differs from the approved integration manifest.',
    );
  }

  return {
    baseBranch,
    behindBy:
      comparison.behind_by,
  };
}

function verifyPrBaseAndScope({
  manifest,
  integrationPath,
  integrationBranch,
  commit,
  baseBranch,
}) {
  try {
    gitTrim(
      [
        'check-ref-format',
        '--branch',
        baseBranch,
      ],
      integrationPath,
    );
  } catch {
    throw new Error(
      `Recorded PR base branch is not a valid Git branch name: ${baseBranch}`,
    );
  }

  const remoteResultBefore =
    gitTrim(
      [
        'ls-remote',
        '--heads',
        REMOTE,
        `refs/heads/${baseBranch}`,
      ],
      integrationPath,
    );

  if (!remoteResultBefore) {
    throw new Error(
      `Recorded PR base branch does not exist on ${REMOTE}: ${baseBranch}`,
    );
  }

  const remoteFieldsBefore =
    remoteResultBefore
      .split(/\s+/)
      .filter(Boolean);

  if (
    remoteFieldsBefore.length < 2 ||
    !/^[0-9a-f]{40,64}$/i.test(
      remoteFieldsBefore[0] ?? '',
    )
  ) {
    throw new Error(
      'Could not parse the recorded PR base branch identity.',
    );
  }

  const remoteBaseCommit =
    remoteFieldsBefore[0];

  const comparison =
    ghJson(
      [
        'api',
        `repos/${EXPECTED_REPO}/compare/${remoteBaseCommit}...${commit}`,
      ],
      integrationPath,
    );

  const validated =
    validatePrComparison({
      manifest,
      comparison,
      baseBranch,
      commit,
    });

  const remoteResultAfter =
    gitTrim(
      [
        'ls-remote',
        '--heads',
        REMOTE,
        `refs/heads/${baseBranch}`,
      ],
      integrationPath,
    );

  if (!remoteResultAfter) {
    throw new Error(
      `Recorded PR base branch disappeared during verification: ${baseBranch}`,
    );
  }

  const remoteFieldsAfter =
    remoteResultAfter
      .split(/\s+/)
      .filter(Boolean);

  if (
    remoteFieldsAfter.length < 2 ||
    !/^[0-9a-f]{40,64}$/i.test(
      remoteFieldsAfter[0] ?? '',
    ) ||
    remoteFieldsAfter[0] !==
      remoteBaseCommit
  ) {
    throw new Error(
      'Recorded PR base branch moved while PR scope was being verified.',
    );
  }

  return {
    ...validated,
    remoteBaseCommit,
  };
}

function gitText(
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
  );
}

function gitTrim(
  args,
  cwd,
) {
  return gitText(
    args,
    cwd,
  ).trim();
}

function gitBuffer(
  args,
  cwd,
) {
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

function ghText(
  args,
  cwd,
) {
  return execFileSync(
    'gh',
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

function ghJson(
  args,
  cwd,
) {
  const output =
    ghText(
      args,
      cwd,
    );

  try {
    return JSON.parse(
      output,
    );
  } catch {
    throw new Error(
      'GitHub CLI returned invalid JSON.',
    );
  }
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
      'Orchestrator working tree must be clean before PR operations.',
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
      'PR operations must be launched from a non-main orchestrator branch.',
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
      `Multiple manifests found for ${sessionId}. PR operation refused.`,
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
    'integration-pushed'
  ) {
    throw new Error(
      `Session is not PR-ready. Required status: integration-pushed. Current status: ${manifest.status ?? 'unknown'}.`,
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
    integration.remote !==
    REMOTE
  ) {
    throw new Error(
      'Integration remote is not the approved origin remote.',
    );
  }

  if (
    integration.remoteBranch !==
    integration.branch
  ) {
    throw new Error(
      'Recorded remote branch does not match the integration branch.',
    );
  }

  if (
    integration.remoteCommit !==
    integration.commit
  ) {
    throw new Error(
      'Recorded remote commit does not match the approved integration commit.',
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
      'Approved integration commit is invalid.',
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
    !Array.isArray(
      integration.changedPaths,
    ) ||
    integration.changedPaths.length ===
      0
  ) {
    throw new Error(
      'Integration fingerprints are missing.',
    );
  }

  for (
    const change
    of integration.changedPaths
  ) {
    normalizeRepoPath(
      change.path,
    );

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
          `Invalid fingerprint for ${change.path}.`,
        );
      }
    } else if (
      change.operation !==
      'delete'
    ) {
      throw new Error(
        `Unsupported integration operation: ${change.path}`,
      );
    }
  }

  return manifest;
}

function verifyLocalCommit(
  manifest,
) {
  const integration =
    manifest.integration;

  const integrationPath =
    integration.path;

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
      'Integration HEAD differs from the approved commit.',
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
      'Committed path set differs from the approved manifest.',
    );
  }

  for (
    const change
    of integration.changedPaths
  ) {
    if (
      change.operation !==
      'copy'
    ) {
      continue;
    }

    const path =
      normalizeRepoPath(
        change.path,
      );

    const fullPath =
      join(
        integrationPath,
        path,
      );

    const worktreeHash =
      sha256Buffer(
        readFileSync(
          fullPath,
        ),
      );

    if (
      worktreeHash.toLowerCase() !==
      change.sha256.toLowerCase()
    ) {
      throw new Error(
        `Committed worktree fingerprint mismatch: ${path}`,
      );
    }

    let expectedCommittedObject;

    try {
      expectedCommittedObject =
        gitTrim(
          [
            'hash-object',
            `--path=${path}`,
            fullPath,
          ],
          integrationPath,
        );
    } catch {
      throw new Error(
        `Unable to compute Git-filtered committed fingerprint: ${path}`,
      );
    }

    let committedObject;

    try {
      committedObject =
        gitTrim(
          [
            'rev-parse',
            `${integration.commit}:${path}`,
          ],
          integrationPath,
        );
    } catch {
      throw new Error(
        `Unable to read committed file identity: ${path}`,
      );
    }

    if (
      committedObject !==
      expectedCommittedObject
    ) {
      throw new Error(
        `Committed fingerprint mismatch: ${path}`,
      );
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

function verifyRemoteCommit({
  integrationPath,
  integrationBranch,
  commit,
}) {
  const result =
    gitTrim(
      [
        'ls-remote',
        '--heads',
        REMOTE,
        `refs/heads/${integrationBranch}`,
      ],
      integrationPath,
    );

  if (!result) {
    throw new Error(
      'Approved integration branch does not exist on origin.',
    );
  }

  const fields =
    result
      .split(/\s+/)
      .filter(Boolean);

  if (
    fields.length < 2 ||
    fields[1] !==
      `refs/heads/${integrationBranch}`
  ) {
    throw new Error(
      'Unexpected remote branch response.',
    );
  }

  if (
    fields[0] !== commit
  ) {
    throw new Error(
      'Remote integration branch does not point to the approved commit.',
    );
  }
}

function verifyRepositoryIdentity(
  integrationPath,
) {
  const repo =
    ghJson(
      [
        'repo',
        'view',
        '--json',
        'nameWithOwner,defaultBranchRef',
      ],
      integrationPath,
    );

  if (
    repo.nameWithOwner !==
    EXPECTED_REPO
  ) {
    throw new Error(
      `GitHub repository mismatch. Expected ${EXPECTED_REPO}, received ${repo.nameWithOwner ?? 'unknown'}.`,
    );
  }

  if (
    repo.defaultBranchRef
      ?.name !==
    DEFAULT_BRANCH
  ) {
    throw new Error(
      `Default branch mismatch. Expected ${DEFAULT_BRANCH}, received ${repo.defaultBranchRef?.name ?? 'unknown'}.`,
    );
  }
}

function findExistingPr({
  integrationPath,
  integrationBranch,
}) {
  const prs =
    ghJson(
      [
        'pr',
        'list',
        '--repo',
        EXPECTED_REPO,
        '--state',
        'all',
        '--head',
        integrationBranch,
        '--json',
        'number,url,state,headRefName,baseRefName',
      ],
      integrationPath,
    );

  if (
    !Array.isArray(prs)
  ) {
    throw new Error(
      'Unexpected GitHub PR query response.',
    );
  }

  if (
    prs.length > 0
  ) {
    const existing =
      prs[0];

    throw new Error(
      `A pull request already exists for ${integrationBranch}: #${existing.number} ${existing.url}`,
    );
  }
}

function buildPrTitle(
  manifest,
) {
  const summary =
    String(
      manifest.plan?.summary ??
      manifest.task ??
      '',
    )
      .replace(/\s+/g, ' ')
      .trim();

  const prefix =
    `AI integration ${manifest.sessionId}`;

  if (!summary) {
    return prefix;
  }

  const available =
    Math.max(
      0,
      120 -
      prefix.length -
      3,
    );

  return (
    `${prefix}: ` +
    summary.slice(
      0,
      available,
    )
  );
}

function buildPrBody(
  manifest,
  baseBranch,
) {
  const task =
    String(
      manifest.task ??
      '(task not recorded)',
    ).trim();

  return [
    '## Controlled AI integration',
    '',
    `Session: \`${manifest.sessionId}\``,
    `Base: \`${baseBranch}\``,
    `Head: \`${manifest.integration.branch}\``,
    `Approved commit: \`${manifest.integration.commit}\``,
    '',
    '### Original task',
    '',
    task,
    '',
    '### Safety boundary',
    '',
    '- Worker ownership audits passed before integration.',
    '- Prepared file fingerprints were verified before commit.',
    '- Remote branch was verified against the approved commit.',
    '- This PR was opened without merging.',
    '- Human review and CI are required before merge.',
  ].join('\n');
}

function createPullRequest({
  manifest,
  integrationPath,
  integrationBranch,
  baseBranch,
}) {
  const title =
    buildPrTitle(
      manifest,
    );

  const body =
    buildPrBody(
      manifest,
      baseBranch,
    );

  const url =
    ghText(
      [
        'pr',
        'create',
        '--repo',
        EXPECTED_REPO,
        '--base',
        baseBranch,
        '--head',
        integrationBranch,
        '--title',
        title,
        '--body',
        body,
      ],
      integrationPath,
    ).trim();

  if (
    !/^https:\/\/github\.com\//i.test(
      url,
    )
  ) {
    throw new Error(
      'GitHub did not return a valid pull request URL.',
    );
  }

  const prs =
    ghJson(
      [
        'pr',
        'list',
        '--repo',
        EXPECTED_REPO,
        '--state',
        'open',
        '--head',
        integrationBranch,
        '--json',
        'number,url,state,headRefName,baseRefName,headRefOid',
      ],
      integrationPath,
    );

  if (
    !Array.isArray(prs) ||
    prs.length !== 1
  ) {
    throw new Error(
      'Unable to uniquely verify the newly created pull request.',
    );
  }

  const pr =
    prs[0];

  if (
    pr.headRefName !==
    integrationBranch
  ) {
    throw new Error(
      'Created PR head branch mismatch.',
    );
  }

  if (
    pr.baseRefName !==
    baseBranch
  ) {
    throw new Error(
      'Created PR base branch mismatch.',
    );
  }

  if (
    pr.headRefOid &&
    pr.headRefOid !==
    manifest.integration.commit
  ) {
    throw new Error(
      'Created PR head commit does not match the approved integration commit.',
    );
  }

  return pr;
}

function updateManifestPrOpened({
  manifestPath,
  manifest,
  pr,
  baseBranch,
}) {
  const now =
    new Date()
      .toISOString();

  manifest.status =
    'pr-opened';

  manifest.updatedAt =
    now;

  manifest.integration.pullRequest = {
    openedAt:
      now,

    repository:
      EXPECTED_REPO,

    number:
      pr.number,

    url:
      pr.url,

    state:
      pr.state,

    baseBranch:
      baseBranch,

    headBranch:
      manifest.integration.branch,

    commit:
      manifest.integration.commit,
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

export function runOpenPr({
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
      ? 'PULL REQUEST PREFLIGHT'
      : 'HUMAN-APPROVED PULL REQUEST',
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
    'PUSHED MANIFEST: PASS',
  );

  const {
    integrationPath,
    integrationBranch,
    commit,
  } =
    verifyLocalCommit(
      manifest,
    );

  console.log(
    'LOCAL COMMIT AUDIT: PASS',
  );

  verifyRemoteCommit({
    integrationPath,
    integrationBranch,
    commit,
  });

  console.log(
    'REMOTE COMMIT AUDIT: PASS',
  );

  verifyRepositoryIdentity(
    integrationPath,
  );

  console.log(
    `REPOSITORY IDENTITY: PASS (${EXPECTED_REPO})`,
  );

  console.log(
    `DEFAULT BRANCH: PASS (${DEFAULT_BRANCH})`,
  );

  const baseBranch =
    resolvePrBaseBranch(
      manifest,
    );

  const baseScope =
    verifyPrBaseAndScope({
      manifest,
      integrationPath,
      integrationBranch,
      commit,
      baseBranch,
    });

  console.log(
    `PR BASE SCOPE: PASS (${baseBranch} @ ${baseScope.remoteBaseCommit}; base ahead by ${baseScope.behindBy})`,
  );

  findExistingPr({
    integrationPath,
    integrationBranch,
  });

  console.log(
    'EXISTING PR CHECK: PASS',
  );

  if (checkOnly) {
    console.log('');
    console.log(
      'PULL REQUEST PREFLIGHT COMPLETE',
    );

    console.log(
      'No pull request was created.',
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
      baseBranch,
    };
  }

  console.log('');
  console.log(
    'Creating pull request...',
  );

  const pr =
    createPullRequest({
      manifest,
      integrationPath,
      integrationBranch,
      baseBranch,
    });

  updateManifestPrOpened({
    manifestPath,
    manifest,
    pr,
    baseBranch,
  });

  console.log('');
  console.log(
    '=================================',
  );

  console.log(
    'PULL REQUEST OPENED',
  );

  console.log(
    '=================================',
  );

  console.log(
    `PR: #${pr.number}`,
  );

  console.log(
    `URL: ${pr.url}`,
  );

  console.log(
    `Base: ${baseBranch}`,
  );

  console.log(
    `Head: ${integrationBranch}`,
  );

  console.log(
    `Commit: ${commit}`,
  );

  console.log('');
  console.log(
    'Manifest status: pr-opened',
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
    'NOTE: GitHub Actions or other remote automation may run because a PR was opened.',
  );

  console.log('');
  console.log(
    'STOP: CI and human review are required before merge.',
  );

  return {
    manifestPath,
    integrationPath,
    integrationBranch,
    commit,
    baseBranch,
    pr,
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
        'Usage: node scripts/ai-open-pr.mjs --check <14-digit-session-id>',
      );
    }
  } else {
    sessionId =
      args[0]?.trim();

    if (
      args.length !== 1
    ) {
      throw new Error(
        'Usage: node scripts/ai-open-pr.mjs <14-digit-session-id>',
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
      'Pull request operation requires a 14-digit session ID.',
    );
  }

  runOpenPr({
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
        'Pull request operation failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
