#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  resolvePrBaseBranch,
  validatePrComparison,
} from './ai-open-pr.mjs';

const baseCommit =
  'a'.repeat(40);

const integrationCommit =
  'b'.repeat(40);

const manifest = {
  targetBranch:
    'feat/example-stacked-base',

  baseCommit,

  integration: {
    branch:
      'ai/integrate-20990101010101',

    commit:
      integrationCommit,

    changedPaths: [
      {
        path:
          'app/example/page.tsx',
      },
      {
        path:
          'lib/example.ts',
      },
    ],
  },
};

assert.equal(
  resolvePrBaseBranch(
    manifest,
  ),
  'feat/example-stacked-base',
);

assert.throws(
  () =>
    resolvePrBaseBranch({
      ...manifest,
      targetBranch:
        undefined,
    }),
  /recorded targetBranch/,
);

assert.throws(
  () =>
    resolvePrBaseBranch({
      ...manifest,
      targetBranch:
        manifest.integration.branch,
    }),
  /may not equal the integration branch/,
);

const makeComparison =
  ({
    status = 'ahead',
    aheadBy = 1,
    behindBy = 0,
    totalCommits = 1,
    mergeBase =
      baseCommit,
    commit =
      integrationCommit,
    files = [
      'app/example/page.tsx',
      'lib/example.ts',
    ],
  } = {}) => ({
    status,

    ahead_by:
      aheadBy,

    behind_by:
      behindBy,

    total_commits:
      totalCommits,

    merge_base_commit: {
      sha:
        mergeBase,
    },

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

const direct =
  validatePrComparison({
    manifest,
    comparison:
      makeComparison(),
    baseBranch:
      manifest.targetBranch,
    commit:
      integrationCommit,
  });

assert.equal(
  direct.behindBy,
  0,
);

const advanced =
  validatePrComparison({
    manifest,
    comparison:
      makeComparison({
        status:
          'behind',
        behindBy:
          4,
      }),
    baseBranch:
      manifest.targetBranch,
    commit:
      integrationCommit,
  });

assert.equal(
  advanced.behindBy,
  4,
);

assert.throws(
  () =>
    validatePrComparison({
      manifest,
      comparison:
        makeComparison({
          mergeBase:
            'd'.repeat(40),
        }),
      baseBranch:
        manifest.targetBranch,
      commit:
        integrationCommit,
    }),
  /merge-base no longer matches/,
);

assert.throws(
  () =>
    validatePrComparison({
      manifest,
      comparison:
        makeComparison({
          files: [
            'app/example/page.tsx',
            'lib/example.ts',
            'unexpected.txt',
          ],
        }),
      baseBranch:
        manifest.targetBranch,
      commit:
        integrationCommit,
    }),
  /path set differs/,
);

assert.throws(
  () =>
    validatePrComparison({
      manifest,
      comparison:
        makeComparison({
          commit:
            'e'.repeat(40),
        }),
      baseBranch:
        manifest.targetBranch,
      commit:
        integrationCommit,
    }),
  /commit set does not equal/,
);

assert.throws(
  () =>
    validatePrComparison({
      manifest,
      comparison:
        makeComparison({
          aheadBy:
            2,
          totalCommits:
            2,
        }),
      baseBranch:
        manifest.targetBranch,
      commit:
        integrationCommit,
    }),
  /not exactly one approved head commit/,
);

console.log(
  'AI open-PR base smoke: PASS',
);

console.log(
  'Recorded stacked base, advanced-base comparison, exact merge-base, one approved commit, and exact file scope verified.',
);