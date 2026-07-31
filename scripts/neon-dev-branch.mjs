/**
 * Provision the persistent `development` Neon branch and point `.env.local` at
 * it — eliminating the production/development coupling where local work runs
 * against the production database.
 *
 *   NEON_API_KEY=neon_api_... node scripts/neon-dev-branch.mjs
 *
 * Then, against the new branch:
 *   npm run db:migrate
 *   npm run db:seed
 *
 * Idempotent: re-running reuses an existing `development` branch rather than
 * creating a second one, and rewrites `.env.local` to match.
 *
 * SAFETY: this script only ever creates/reads a NON-default branch and rewrites
 * the local `.env.local`. It never writes to the production branch, never runs
 * DDL, and never touches Vercel project settings. The production branch is
 * used strictly as the copy-on-write parent.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const API = 'https://console.neon.tech/api/v2'

const API_KEY = process.env.NEON_API_KEY
const PROJECT_NAME = process.env.NEON_PROJECT_NAME ?? 'cloud-market'
const PROJECT_ID = process.env.NEON_PROJECT_ID
const BRANCH_NAME = process.env.NEON_DEV_BRANCH ?? 'development'
const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'
const ENV_FILE = '.env.local'

if (!API_KEY) {
  console.error(
    'NEON_API_KEY is not set.\n' +
      'Create one at https://console.neon.tech/app/settings/api-keys, then:\n' +
      '  NEON_API_KEY=neon_api_... node scripts/neon-dev-branch.mjs',
  )
  process.exit(1)
}

/** Truncated digest of a hostname — matches the scheme used by /api/health. */
function fingerprint(connectionString) {
  try {
    return createHash('sha256')
      .update(new URL(connectionString).hostname)
      .digest('hex')
      .slice(0, 12)
  } catch {
    return null
  }
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text}`)
  }
  return text ? JSON.parse(text) : {}
}

async function resolveProject() {
  if (PROJECT_ID) return { id: PROJECT_ID, name: '(by id)' }

  const { projects } = await api('/projects')
  const match = projects.filter((p) => p.name === PROJECT_NAME)

  if (match.length === 0) {
    const names = projects.map((p) => p.name).join(', ') || '(none)'
    throw new Error(
      `No Neon project named "${PROJECT_NAME}". Available: ${names}. ` +
        'Set NEON_PROJECT_NAME or NEON_PROJECT_ID.',
    )
  }
  if (match.length > 1) {
    throw new Error(
      `${match.length} Neon projects named "${PROJECT_NAME}". Set NEON_PROJECT_ID to disambiguate.`,
    )
  }
  return match[0]
}

async function findOrCreateBranch(projectId) {
  const { branches } = await api(`/projects/${projectId}/branches`)

  const existing = branches.find((b) => b.name === BRANCH_NAME)
  if (existing) {
    /**
     * Guard against pointing local development at production. If someone has
     * named the default branch `development`, writing its credentials into
     * .env.local would recreate exactly the coupling this script removes.
     */
    if (existing.default || existing.primary) {
      throw new Error(
        `Branch "${BRANCH_NAME}" is the project's DEFAULT (production) branch. ` +
          'Refusing to point local development at production.',
      )
    }
    console.log(`Reusing existing branch "${BRANCH_NAME}" (${existing.id})`)
    return existing
  }

  const parent = branches.find((b) => b.default) ?? branches.find((b) => b.primary)
  if (!parent) throw new Error('Could not identify the default (production) branch.')

  console.log(`Creating branch "${BRANCH_NAME}" from "${parent.name}" (copy-on-write)…`)
  const created = await api(`/projects/${projectId}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name: BRANCH_NAME, parent_id: parent.id },
      endpoints: [{ type: 'read_write' }],
    }),
  })
  console.log(`Created branch ${created.branch.id}`)
  return created.branch
}

async function connectionUri(projectId, branchId, pooled) {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: DATABASE,
    role_name: ROLE,
    pooled: String(pooled),
  })

  // A freshly created endpoint takes a moment to become routable.
  let lastError
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const { uri } = await api(`/projects/${projectId}/connection_uri?${params}`)
      if (uri) return uri
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  throw new Error(
    `Timed out fetching the ${pooled ? 'pooled' : 'direct'} connection URI. ${lastError ?? ''}`,
  )
}

/** Rewrite only the two database lines, preserving comments and every other key. */
function updateEnvFile(pooledUri, directUri) {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`${ENV_FILE} not found. Copy .env.example first.`)
  }

  const original = readFileSync(ENV_FILE, 'utf8')
  const replacements = {
    DATABASE_URL: pooledUri,
    DATABASE_URL_UNPOOLED: directUri,
  }

  let updated = original
  for (const [key, value] of Object.entries(replacements)) {
    const line = `${key}="${value}"`
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    updated = pattern.test(updated) ? updated.replace(pattern, line) : `${updated.trimEnd()}\n${line}\n`
  }

  writeFileSync(ENV_FILE, updated, 'utf8')
}

async function main() {
  const project = await resolveProject()
  console.log(`Project: ${project.name} (${project.id})`)

  const branch = await findOrCreateBranch(project.id)

  const pooled = await connectionUri(project.id, branch.id, true)
  const direct = await connectionUri(project.id, branch.id, false)

  // Endpoint shape is asserted here so a bad pair never reaches .env.local.
  if (!new URL(pooled).hostname.includes('-pooler')) {
    throw new Error('Expected a pooled host (containing "-pooler") for DATABASE_URL.')
  }
  if (new URL(direct).hostname.includes('-pooler')) {
    throw new Error('Expected a direct host (no "-pooler") for DATABASE_URL_UNPOOLED.')
  }

  updateEnvFile(pooled, direct)

  // Fingerprints only — never hostnames, never passwords.
  console.log(`\n${ENV_FILE} updated:`)
  console.log(`  DATABASE_URL          pooled  fingerprint=${fingerprint(pooled)}`)
  console.log(`  DATABASE_URL_UNPOOLED direct  fingerprint=${fingerprint(direct)}`)
  console.log(
    '\nNext:\n' +
      '  npm run db:migrate   # apply migrations to the development branch\n' +
      '  npm run db:seed      # seed it\n' +
      '  curl -s localhost:3000/api/health   # confirm the development fingerprint\n',
  )
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`)
  process.exitCode = 1
})
