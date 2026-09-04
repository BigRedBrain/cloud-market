#!/usr/bin/env node

import {
  execFileSync,
} from 'node:child_process';

import {
  resolve,
} from 'node:path';

import {
  pathToFileURL,
} from 'node:url';

import {
  runRecoverPr,
} from './ai-open-pr.mjs';

function getRepoRoot() {
  return resolve(
    execFileSync(
      'git',
      [
        'rev-parse',
        '--show-toplevel',
      ],
      {
        encoding:
          'utf8',
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    ).trim(),
  );
}

function parseArgs() {
  const args =
    process.argv.slice(2);

  if (
    args.length !== 6 ||
    (
      args[0] !== '--check' &&
      args[0] !== '--execute'
    )
  ) {
    throw new Error(
      'Usage: node scripts/ai-recover-pr.mjs <--check|--execute> <14-digit-session-id> <replacement-pr-number> <expected-base-branch> <expected-recovery-head-branch> <expected-40-char-head-sha>',
    );
  }

  const sessionId =
    args[1]?.trim();

  if (
    !sessionId ||
    !/^\d{14}$/.test(
      sessionId,
    )
  ) {
    throw new Error(
      'Recovery requires a 14-digit session ID.',
    );
  }

  const replacementNumber =
    Number(
      args[2],
    );

  if (
    !Number.isInteger(
      replacementNumber,
    ) ||
    replacementNumber < 1
  ) {
    throw new Error(
      'Recovery requires a positive replacement PR number.',
    );
  }

  const expectedBaseBranch =
    args[3]?.trim();

  const expectedHeadBranch =
    args[4]?.trim();

  const expectedHeadCommit =
    args[5]?.trim();

  if (
    !expectedBaseBranch ||
    !expectedHeadBranch ||
    !expectedHeadCommit
  ) {
    throw new Error(
      'Recovery base branch, head branch, and head commit are required explicitly.',
    );
  }

  return {
    checkOnly:
      args[0] ===
      '--check',

    sessionId,
    replacementNumber,
    expectedBaseBranch,
    expectedHeadBranch,
    expectedHeadCommit,
  };
}

async function runCli() {
  const options =
    parseArgs();

  runRecoverPr({
    repoRoot:
      getRepoRoot(),

    ...options,
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
        'Replacement PR recovery failed:',
      );
      console.error(
        error?.message ??
        String(error),
      );
      process.exitCode = 1;
    },
  );
}
