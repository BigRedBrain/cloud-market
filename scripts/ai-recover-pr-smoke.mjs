#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  buildRecoveryManifestUpdate,
  validateRecoveryComparison,
  validateRecoveryHeadBranch,
} from './ai-open-pr.mjs';

const sessionId =
  '20990101010101';

const baseCommit =
  'a'.repeat(40);

const integrationCommit =
  'b'.repeat(40);

const recoveryCommit =
  'c'.repeat(40);

const manifest = {
  manifestVersion:
    1,

  sessionId,

  status:
    'pr-opened',

  baseCommit,

  integration: {
    branch:
      `ai/integrate-${sessionId}`,

    commit:
      integrationCommit,

    changedPaths: [
      {
        path:
          'app/example/page.tsx',

        sha256:
          '1'.repeat(64),
      },
      {
        path:
          'lib/example.ts',

        sha256:
          '2'.repeat(64),
      },
    ],

    pullRequest: {
      openedAt:
        '2099-01-01T00:00:00.000Z',

      repository:
        'BigRedBrain/cloud-market',

      number:
        40,

      url:
        'https://github.com/BigRedBrain/cloud-market/pull/40',

      state:
        'OPEN',

      baseBranch:
        'feat/stacked-base',

      headBranch:
        `ai/integrate-${sessionId}`,

      commit:
        integrationCommit,
    },
  },
};

assert.equal(
  validateRecoveryHeadBranch({
    sessionId,
    headBranch:
      `ai/recover-${sessionId}`,
    integrationBranch:
      manifest.integration.branch,
  }),
  `ai/recover-${sessionId}`,
);

assert.equal(
  validateRecoveryHeadBranch({
    sessionId,
    headBranch:
      `ai/recover-notifications-${sessionId}`,
    integrationBranch:
      manifest.integration.branch,
  }),
  `ai/recover-notifications-${sessionId}`,
);

assert.throws(
  () =>
    validateRecoveryHeadBranch({
      sessionId,
      headBranch:
        'ai/recover-other-session',
      integrationBranch:
        manifest.integration.branch,
    }),
  /session-scoped recovery name/,
);

assert.throws(
  () =>
    validateRecoveryHeadBranch({
      sessionId,
      headBranch:
        manifest.integration.branch,
      integrationBranch:
        manifest.integration.branch,
    }),
  /separate from the original integration branch/,
);

const makeComparison =
  ({
    mergeBase =
      baseCommit,
    aheadBy = 1,
    behindBy = 0,
    totalCommits = 1,
    commit =
      recoveryCommit,
    files = [
      'app/example/page.tsx',
      'lib/example.ts',
    ],
  } = {}) => ({
    merge_base_commit: {
      sha:
        mergeBase,
    },

    ahead_by:
      aheadBy,

    behind_by:
      behindBy,

    total_commits:
      totalCommits,

    commits: [
      {
        sha:
          commit,
      },
    ],

    files:
      files.map(
        (filename) => ({
          filename,
        }),
      ),
  });

validateRecoveryComparison({
  manifest,
  comparison:
    makeComparison(),
  baseCommit,
  headCommit:
    recoveryCommit,
});

assert.throws(
  () =>
    validateRecoveryComparison({
      manifest,
      comparison:
        makeComparison({
          behindBy:
            1,
        }),
      baseCommit,
      headCommit:
        recoveryCommit,
    }),
  /no base drift/,
);

assert.throws(
  () =>
    validateRecoveryComparison({
      manifest,
      comparison:
        makeComparison({
          mergeBase:
            'd'.repeat(40),
        }),
      baseCommit,
      headCommit:
        recoveryCommit,
    }),
  /merge-base/,
);

assert.throws(
  () =>
    validateRecoveryComparison({
      manifest,
      comparison:
        makeComparison({
          files: [
            'app/example/page.tsx',
            'lib/example.ts',
            'unexpected.txt',
          ],
        }),
      baseCommit,
      headCommit:
        recoveryCommit,
    }),
  /path set differs/,
);

const candidate = {
  oldPr: {
    number:
      40,

    liveState:
      'CLOSED',

    observedBaseBranch:
      'main',

    headBranch:
      manifest.integration
        .branch,

    commit:
      integrationCommit,
  },

  replacementPr: {
    number:
      41,

    url:
      'https://github.com/BigRedBrain/cloud-market/pull/41',

    createdAt:
      '2099-01-02T00:00:00.000Z',

    baseBranch:
      'main',

    headBranch:
      `ai/recover-notifications-${sessionId}`,

    commit:
      recoveryCommit,
  },

  verifiedBaseCommit:
    'e'.repeat(40),

  verifiedHeadTree:
    'f'.repeat(40),
};

const updated =
  buildRecoveryManifestUpdate({
    manifest,
    candidate,
    now:
      '2099-01-02T01:00:00.000Z',
  });

assert.equal(
  updated.status,
  'pr-opened',
);

assert.equal(
  updated.targetBranch,
  undefined,
);

assert.equal(
  updated.integration
    .pullRequestHistory
    .length,
  1,
);

assert.equal(
  updated.integration
    .pullRequestHistory[0]
    .number,
  40,
);

assert.equal(
  updated.integration
    .pullRequestHistory[0]
    .supersededBy,
  41,
);

assert.equal(
  updated.integration
    .pullRequest.number,
  41,
);

assert.equal(
  updated.integration
    .pullRequest.baseBranch,
  'main',
);

assert.equal(
  updated.integration
    .pullRequest.headBranch,
  `ai/recover-notifications-${sessionId}`,
);

assert.equal(
  updated.integration
    .pullRequest.commit,
  recoveryCommit,
);

assert.equal(
  updated.integration
    .pullRequest.recovery
    .previousNumber,
  40,
);

assert.equal(
  manifest.integration
    .pullRequest.number,
  40,
);

console.log(
  'AI replacement-PR recovery smoke: PASS',
);

console.log(
  'Session-scoped recovery naming, exact comparison scope, legacy-manifest compatibility, PR history preservation, and replacement metadata verified.',
);
