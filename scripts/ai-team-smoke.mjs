#!/usr/bin/env node
/**
 * ai-team-smoke.mjs
 *
 * Parallel smoke test for the CloudMarket AI team wiring.
 *
 * Runs two independent agents at the same time and prints both answers:
 *   1. An OpenAI agent (@openai/agents) on model gpt-5.6-sol
 *   2. Claude Code in non-interactive mode (`claude -p`, --max-turns 1)
 *
 * This touches nothing else: no database, no network services beyond the two
 * model providers, no repo mutations. It only proves both lanes can run
 * concurrently.
 *
 * Usage:
 *   node scripts/ai-team-smoke.mjs
 *
 * Requires OPENAI_API_KEY in the environment and a working `claude` CLI on PATH
 * (or the npm global install on Windows).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Agent, run } from '@openai/agents';

const GPT_MODEL = 'gpt-5.6-sol';
const GPT_PROMPT =
  'This is a connectivity smoke test. Reply with exactly this text and nothing else: GPT PARALLEL OK';
const CLAUDE_PROMPT =
  'This is a connectivity smoke test. Reply with exactly this text and nothing else: CLAUDE PARALLEL OK';

const CLAUDE_TIMEOUT_MS = 120_000;
const CLAUDE_ENV_DENYLIST = [
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'NEON_API_KEY',
  'NEON_PROJECT_ID',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'INVITE_CODE_PEPPER',
  'CRON_SECRET',
  'BLOB_READ_WRITE_TOKEN',
];

const CLAUDE_ENV_DENY_PATTERNS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'DATABASE_URL',
  'API_KEY',
];
/** Run the OpenAI agent and return its final text output. */
async function runGptAgent() {
  const agent = new Agent({
    name: 'CloudMarket GPT Smoke',
    model: GPT_MODEL,
    instructions:
      'You are a smoke-test probe. Answer with the exact literal string requested, no punctuation or commentary added.',
  });

  const result = await run(agent, GPT_PROMPT);
  return (result.finalOutput ?? '').toString().trim();
}

/**
 * Resolve the Claude Code executable.
 *
 * On Windows we point at the native binary from the npm global install rather
 * than the `claude.cmd` shim, so the child can be spawned directly with no
 * shell involved. Elsewhere we rely on `claude` being on PATH.
 */
function resolveClaudeCommand() {
  if (process.platform !== 'win32') {
    return 'claude';
  }

  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('APPDATA is not set; cannot locate claude.exe on Windows');
  }

  return join(
    appData,
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
}

/** Launch Claude Code non-interactively and return its stdout. */
function runClaudeCode() {
  const command = resolveClaudeCommand();
  const args = [
  '-p',
  CLAUDE_PROMPT,
  '--max-turns', '1',
  '--permission-mode', 'plan',
  '--tools', 'Read,Glob,Grep',
  '--strict-mcp-config',
  '--safe-mode',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--no-chrome',
];

  // Keep the OpenAI credentials out of the Claude child process entirely.
  const { claudeEnv, stripped } = buildClaudeEnv();

if (stripped.length > 0) {
  console.log(
    `  Claude environment stripped: ${stripped.join(', ')}`,
  );
}

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: claudeEnv,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to launch "${command}": ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`claude exited with code ${code}: ${stderr.trim() || '(no stderr)'}`),
        );
      }
    });
  });
}

function buildClaudeEnv() {
  const denySet = new Set(
    CLAUDE_ENV_DENYLIST.map((name) => name.toUpperCase()),
  );

  const claudeEnv = {};
  const stripped = [];

  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();

    const isDenied =
      denySet.has(upper) ||
      CLAUDE_ENV_DENY_PATTERNS.some((pattern) =>
        upper.includes(pattern),
      );

    if (isDenied) {
      stripped.push(name);
      continue;
    }

    claudeEnv[name] = value;
  }

  return {
    claudeEnv,
    stripped: stripped.sort(),
  };
}

async function main() {
  console.log('Starting parallel AI team smoke test...');
  console.log(`  lane 1: @openai/agents  (${GPT_MODEL})`);
  console.log('  lane 2: claude -p --max-turns 1');
  console.log('');

  const startedAt = process.hrtime.bigint();

  const [gptResult, claudeResult] = await Promise.all([
    runGptAgent(),
    runClaudeCode(),
  ]);

  const elapsedMs =
    Number(process.hrtime.bigint() - startedAt) / 1e6;

  console.log('--- GPT result ---');
  console.log(gptResult);
  console.log('');
  console.log('--- Claude result ---');
  console.log(claudeResult);
  console.log('');
  console.log(
    `Both lanes completed in ${elapsedMs.toFixed(0)}ms.`,
  );
}
main().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exitCode = 1;
});
