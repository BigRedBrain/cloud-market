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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

import {
  api,
  assertEndpointShape,
  connectionUri as fetchConnectionUri,
  findDefaultBranch,
  fingerprint,
  listBranches,
  requireApiKey,
  resolveProject as resolveNeonProject,
} from './neon-api.mjs'

const PROJECT_NAME = process.env.NEON_PROJECT_NAME ?? 'cloud-market'
const PROJECT_ID = process.env.NEON_PROJECT_ID
const BRANCH_NAME = process.env.NEON_DEV_BRANCH ?? 'development'
const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'
const ENV_FILE = '.env.local'

const API_KEY = requireApiKey('scripts/neon-dev-branch.mjs')

const resolveProject = () =>
  resolveNeonProject(API_KEY, { projectId: PROJECT_ID, projectName: PROJECT_NAME })

async function findOrCreateBranch(projectId) {
  const branches = await listBranches(API_KEY, projectId)

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

  const parent = findDefaultBranch(branches)

  console.log(`Creating branch "${BRANCH_NAME}" from "${parent.name}" (copy-on-write)…`)
  const created = await api(API_KEY, `/projects/${projectId}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name: BRANCH_NAME, parent_id: parent.id },
      endpoints: [{ type: 'read_write' }],
    }),
  })
  console.log(`Created branch ${created.branch.id}`)
  return created.branch
}

const connectionUri = (projectId, branchId, pooled) =>
  fetchConnectionUri(API_KEY, projectId, branchId, {
    database: DATABASE,
    role: ROLE,
    pooled,
  })

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
  assertEndpointShape(pooled, direct)

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
