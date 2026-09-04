#!/usr/bin/env node

/**
 * CloudMarket AI Development Plan JSON Bridge
 *
 * Runs the existing read-only development planner and emits ONLY
 * the structured JSON plan to stdout.
 *
 * This lets the future ai-dev-run.mjs consume planner output
 * without depending on human-readable terminal formatting.
 *
 * No files are edited.
 * No Claude workers are launched.
 * No worktrees are created.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function readTask() {
  const task = process.argv.slice(2).join(' ').trim();

  if (!task) {
    throw new Error(
      'A development task is required.\n' +
      'Example:\n' +
      '  node scripts/ai-dev-plan-json.mjs "build seller profiles"',
    );
  }

  return task;
}

function main() {
  const task = readTask();

  const plannerPath = fileURLToPath(
    new URL(
      './ai-dev-planner.mjs',
      import.meta.url,
    ),
  );

  const result = spawnSync(
    process.execPath,
    [
      plannerPath,
      task,
    ],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      result.stdout ||
      `Planner exited with code ${result.status}.`,
    );
  }

  const output = result.stdout;

  const marker = 'PLAN COMPLETE';

  const markerIndex = output.indexOf(
    marker,
  );

  if (markerIndex === -1) {
    throw new Error(
      'Planner output did not contain PLAN COMPLETE.',
    );
  }

  const jsonStart = output.indexOf(
    '{',
    markerIndex,
  );

  if (jsonStart === -1) {
    throw new Error(
      'Planner output did not contain JSON.',
    );
  }

  const jsonText = output
    .slice(jsonStart)
    .trim();

  let plan;

  try {
    plan = JSON.parse(
      jsonText,
    );
  } catch (error) {
    throw new Error(
      `Planner JSON could not be parsed: ${error.message}`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      plan,
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(
    error?.message ??
    String(error),
  );

  process.exitCode = 1;
}