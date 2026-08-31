#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';

import {
  dirname,
  join,
  resolve,
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

function safeCommandText(
  command,
  args,
  cwd,
) {
  try {
    return commandText(
      command,
      args,
      cwd,
    );
  } catch {
    return null;
  }
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

function findSessionManifest({
  repoRoot,
  sessionId,
}) {
  const sessionsRoot =
    resolve(
      dirname(repoRoot),
      'cloudmarket-ai-worktrees',
    );

  if (!existsSync(sessionsRoot)) {
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
        existsSync,
      );

  if (matches.length === 0) {
    throw new Error(
      `No session manifest found for ${sessionId}.`,
    );
  }

  if (matches.length !== 1) {
    throw new Error(
      `Multiple manifests found for ${sessionId}. Status is ambiguous.`,
    );
  }

  return matches[0];
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

function readWorktreeState(
  worktreePath,
) {
  if (
    !worktreePath ||
    !existsSync(worktreePath)
  ) {
    return {
      present: false,
      branch: null,
      head: null,
      dirty: null,
      changes: [],
    };
  }

  const branch =
    safeCommandText(
      'git',
      [
        'branch',
        '--show-current',
      ],
      worktreePath,
    );

  const head =
    safeCommandText(
      'git',
      [
        'rev-parse',
        'HEAD',
      ],
      worktreePath,
    );

  const status =
    safeCommandText(
      'git',
      [
        'status',
        '--short',
        '--untracked-files=all',
      ],
      worktreePath,
    );

  const changes =
    status
      ? status
          .split(/\r?\n/)
          .filter(Boolean)
      : [];

  return {
    present: true,
    branch,
    head,
    dirty:
      changes.length > 0,
    changes,
  };
}

function readRemoteState({
  integrationPath,
  remote,
  branch,
}) {
  if (
    !integrationPath ||
    !existsSync(integrationPath) ||
    !remote ||
    !branch
  ) {
    return {
      checked: false,
      exists: null,
      commit: null,
    };
  }

  const result =
    safeCommandText(
      'git',
      [
        'ls-remote',
        '--heads',
        remote,
        `refs/heads/${branch}`,
      ],
      integrationPath,
    );

  if (result === null) {
    return {
      checked: false,
      exists: null,
      commit: null,
    };
  }

  if (!result) {
    return {
      checked: true,
      exists: false,
      commit: null,
    };
  }

  const fields =
    result
      .split(/\s+/)
      .filter(Boolean);

  return {
    checked: true,
    exists: true,
    commit:
      fields[0] ?? null,
  };
}

function readPrState(
  manifest,
) {
  const pr =
    manifest.integration
      ?.pullRequest;

  if (
    !pr?.number ||
    !pr?.repository
  ) {
    return null;
  }

  const output =
    safeCommandText(
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

  if (!output) {
    return {
      available: false,
    };
  }

  try {
    return {
      available: true,
      ...JSON.parse(output),
    };
  } catch {
    return {
      available: false,
    };
  }
}

function shortSha(
  value,
) {
  if (!value) {
    return '(none)';
  }

  return value.slice(
    0,
    12,
  );
}

function yesNo(
  value,
) {
  if (value === null) {
    return 'unknown';
  }

  return value
    ? 'yes'
    : 'no';
}

export function showSessionStatus({
  repoRoot,
  sessionId,
}) {
  const manifestPath =
    findSessionManifest({
      repoRoot,
      sessionId,
    });

  const manifest =
    readManifest(
      manifestPath,
    );

  if (
    manifest.sessionId !==
    sessionId
  ) {
    throw new Error(
      'Manifest session ID does not match the requested session.',
    );
  }

  console.log('');
  console.log(
    'AI SESSION STATUS',
  );
  console.log(
    '=================',
  );

  console.log(
    `Session: ${manifest.sessionId}`,
  );

  console.log(
    `Status:  ${manifest.status ?? 'unknown'}`,
  );

  console.log(
    `Base:    ${manifest.baseRef ?? '(unknown)'}`,
  );

  console.log(
    `Commit:  ${shortSha(manifest.baseCommit)}`,
  );

  if (manifest.plan?.summary) {
    console.log('');
    console.log(
      `Summary: ${manifest.plan.summary}`,
    );
  }

  console.log('');
  console.log(
    'WORKERS',
  );
  console.log(
    '-------',
  );

  for (
    const worker
    of manifest.workers ?? []
  ) {
    const state =
      readWorktreeState(
        worker.path,
      );

    console.log(
      `${worker.role}:`,
    );

    console.log(
      `  Present: ${yesNo(state.present)}`,
    );

    console.log(
      `  Branch:  ${state.branch ?? worker.branch ?? '(unknown)'}`,
    );

    console.log(
      `  HEAD:    ${shortSha(state.head)}`,
    );

    console.log(
      `  Dirty:   ${yesNo(state.dirty)}`,
    );

    if (state.changes.length) {
      console.log(
        `  Changes: ${state.changes.length}`,
      );
    }
  }

  const integration =
    manifest.integration;

  console.log('');
  console.log(
    'INTEGRATION',
  );
  console.log(
    '-----------',
  );

  if (!integration) {
    console.log(
      '  Not prepared.',
    );
  } else {
    const state =
      readWorktreeState(
        integration.path,
      );

    console.log(
      `  Present: ${yesNo(state.present)}`,
    );

    console.log(
      `  Branch:  ${integration.branch ?? '(none)'}`,
    );

    console.log(
      `  Commit:  ${shortSha(integration.commit)}`,
    );

    console.log(
      `  HEAD:    ${shortSha(state.head)}`,
    );

    console.log(
      `  Dirty:   ${yesNo(state.dirty)}`,
    );

    console.log(
      `  Remote:  ${integration.remote ?? '(none)'}`,
    );

    console.log(
      `  Remote branch: ${integration.remoteBranch ?? '(none)'}`,
    );

    const remoteState =
      readRemoteState({
        integrationPath:
          integration.path,

        remote:
          integration.remote,

        branch:
          integration.remoteBranch,
      });

    if (remoteState.checked) {
      console.log(
        `  Remote exists: ${yesNo(remoteState.exists)}`,
      );

      console.log(
        `  Remote HEAD:   ${shortSha(remoteState.commit)}`,
      );
    } else {
      console.log(
        '  Remote state:  not checked',
      );
    }
  }

  console.log('');
  console.log(
    'PULL REQUEST',
  );
  console.log(
    '------------',
  );

  const recordedPr =
    integration
      ?.pullRequest;

  if (!recordedPr) {
    console.log(
      '  None recorded.',
    );
  } else {
    console.log(
      `  Recorded PR: #${recordedPr.number}`,
    );

    console.log(
      `  Recorded state: ${recordedPr.state ?? '(unknown)'}`,
    );

    console.log(
      `  URL: ${recordedPr.url ?? '(unknown)'}`,
    );

    const livePr =
      readPrState(
        manifest,
      );

    if (
      livePr?.available
    ) {
      console.log(
        `  GitHub state: ${livePr.state}`,
      );

      console.log(
        `  Base: ${livePr.baseRefName}`,
      );

      console.log(
        `  Head: ${livePr.headRefName}`,
      );

      console.log(
        `  PR commit: ${shortSha(livePr.headRefOid)}`,
      );
    } else {
      console.log(
        '  GitHub state: unavailable',
      );
    }
  }

  console.log('');
  console.log(
    `Manifest: ${manifestPath}`,
  );

  console.log('');
  console.log(
    'READ-ONLY STATUS COMPLETE',
  );

  console.log(
    'No files, Git refs, GitHub resources, deployments, or database state were changed.',
  );

  return {
    manifestPath,
    manifest,
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
    ) ||
    process.argv.length !== 3
  ) {
    throw new Error(
      'Usage: node scripts/ai-session-status.mjs <14-digit-session-id>',
    );
  }

  showSessionStatus({
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
        'Session status failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
