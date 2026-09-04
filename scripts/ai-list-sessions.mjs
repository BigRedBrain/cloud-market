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

function getRepoRoot() {
  return resolve(
    execFileSync(
      'git',
      [
        'rev-parse',
        '--show-toplevel',
      ],
      {
        cwd:
          process.cwd(),

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
    return null;
  }
}

function shortSha(
  value,
) {
  return value
    ? String(value).slice(0, 12)
    : '-';
}

function formatDate(
  value,
) {
  if (!value) {
    return '-';
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return String(value);
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

function truncate(
  value,
  maxLength,
) {
  const text =
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        0,
        maxLength - 3,
      ),
    ) +
    '...'
  );
}

export function listSessions({
  repoRoot,
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
    console.log('');
    console.log(
      'AI SESSIONS',
    );
    console.log(
      '===========',
    );
    console.log('');
    console.log(
      'No AI worktree directory exists.',
    );
    console.log('');
    console.log(
      'READ-ONLY SESSION LIST COMPLETE',
    );

    return [];
  }

  const sessions = [];

  for (
    const entry
    of readdirSync(
      sessionsRoot,
      {
        withFileTypes: true,
      },
    )
  ) {
    if (
      !entry.isDirectory()
    ) {
      continue;
    }

    const manifestPath =
      join(
        sessionsRoot,
        entry.name,
        'ai-session-manifest.json',
      );

    if (
      !existsSync(
        manifestPath,
      )
    ) {
      continue;
    }

    const manifest =
      readManifest(
        manifestPath,
      );

    if (!manifest) {
      sessions.push({
        sessionId:
          '(invalid)',

        status:
          'invalid-manifest',

        updatedAt:
          null,

        task:
          entry.name,

        baseCommit:
          null,

        manifestPath,
      });

      continue;
    }

    sessions.push({
      sessionId:
        manifest.sessionId ??
        '(unknown)',

      status:
        manifest.status ??
        'unknown',

      updatedAt:
        manifest.updatedAt ??
        manifest.createdAt ??
        null,

      task:
        manifest.plan?.summary ??
        manifest.task ??
        '',

      baseCommit:
        manifest.baseCommit ??
        null,

      manifestPath,
    });
  }

  sessions.sort(
    (a, b) => {
      const aTime =
        a.updatedAt
          ? new Date(
              a.updatedAt,
            ).getTime()
          : 0;

      const bTime =
        b.updatedAt
          ? new Date(
              b.updatedAt,
            ).getTime()
          : 0;

      if (
        bTime !==
        aTime
      ) {
        return (
          bTime -
          aTime
        );
      }

      return String(
        b.sessionId,
      ).localeCompare(
        String(
          a.sessionId,
        ),
      );
    },
  );

  console.log('');
  console.log(
    'AI SESSIONS',
  );
  console.log(
    '===========',
  );

  console.log(
    `Root: ${sessionsRoot}`,
  );

  console.log(
    `Sessions: ${sessions.length}`,
  );

  console.log('');

  if (
    sessions.length === 0
  ) {
    console.log(
      'No session manifests found.',
    );
  } else {
    for (
      const session
      of sessions
    ) {
      console.log(
        session.sessionId,
      );

      console.log(
        `  Status:  ${session.status}`,
      );

      console.log(
        `  Updated: ${formatDate(session.updatedAt)}`,
      );

      console.log(
        `  Base:    ${shortSha(session.baseCommit)}`,
      );

      if (session.task) {
        console.log(
          `  Summary: ${truncate(session.task, 100)}`,
        );
      }

      console.log('');
    }
  }

  console.log(
    'READ-ONLY SESSION LIST COMPLETE',
  );

  console.log(
    'No files, worktrees, branches, remotes, GitHub resources, deployments, or database state were changed.',
  );

  return sessions;
}

async function runCli() {
  if (
    process.argv.length !==
    2
  ) {
    throw new Error(
      'Usage: node scripts/ai-list-sessions.mjs',
    );
  }

  listSessions({
    repoRoot:
      getRepoRoot(),
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
        'Session list failed:',
      );

      console.error(
        error?.message ??
        String(error),
      );

      process.exitCode = 1;
    },
  );
}
