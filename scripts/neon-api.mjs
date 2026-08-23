/**
 * Neon control-plane helpers, shared.
 *
 * NO SIDE EFFECTS ON IMPORT. Nothing here reads the environment, opens a
 * connection, or performs a request until it is called. That matters because
 * the caller that provisions the persistent `development` branch rewrites
 * `.env.local` as part of its job — if these helpers lived in that file, a
 * second script importing them would silently repoint local development at a
 * throwaway branch.
 *
 * WHY THIS FILE EXISTS. The production database fingerprint was hand-copied
 * into eighteen scripts, and when production moved endpoints every one of them
 * went stale at once — still refusing a database that no longer existed, no
 * longer refusing the one that did. That value now lives in
 * `./environment-fingerprints.mjs` and nowhere else; this module is the same
 * lesson applied to the Neon control-plane plumbing.
 *
 * These helpers never decide whether a target is SAFE. That judgement belongs
 * to `evaluateIdentity` in `verify-migration-target.mjs`, which is a pure
 * function with its own tests. This module only fetches facts.
 */
import { createHash } from 'node:crypto'

export const NEON_API = 'https://console.neon.tech/api/v2'

/**
 * Truncated digest of a hostname — matches the scheme used by /api/health.
 *
 * Identifies a database without disclosing one, so it is safe to print.
 */
export function fingerprint(connectionString) {
  try {
    return createHash('sha256')
      .update(new URL(connectionString).hostname)
      .digest('hex')
      .slice(0, 12)
  } catch {
    return null
  }
}

/**
 * The API key, or a clear exit. `invokedAs` keeps the instruction accurate for
 * whichever script asked.
 */
export function requireApiKey(invokedAs) {
  const key = process.env.NEON_API_KEY
  if (!key) {
    console.error(
      'NEON_API_KEY is not set.\n' +
        'Create one at https://console.neon.tech/app/settings/api-keys, then:\n' +
        `  NEON_API_KEY=neon_api_... node ${invokedAs}`,
    )
    process.exit(1)
  }
  return key
}

export async function api(apiKey, path, init = {}) {
  const res = await fetch(`${NEON_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

export async function resolveProject(apiKey, { projectId, projectName }) {
  if (projectId) return { id: projectId, name: '(by id)' }

  const { projects } = await api(apiKey, '/projects')
  const match = projects.filter((p) => p.name === projectName)

  if (match.length === 0) {
    const names = projects.map((p) => p.name).join(', ') || '(none)'
    throw new Error(
      `No Neon project named "${projectName}". Available: ${names}. ` +
        'Set NEON_PROJECT_NAME or NEON_PROJECT_ID.',
    )
  }
  if (match.length > 1) {
    throw new Error(
      `${match.length} Neon projects named "${projectName}". Set NEON_PROJECT_ID to disambiguate.`,
    )
  }
  return match[0]
}

export async function listBranches(apiKey, projectId) {
  const { branches } = await api(apiKey, `/projects/${projectId}/branches`)
  return branches
}

/**
 * The project's default branch — production.
 *
 * Resolved from the API on every run rather than from a remembered id or name,
 * because "which branch is production" is a fact the control plane owns and a
 * stale local answer is the worst possible thing to be wrong about here.
 */
export function findDefaultBranch(branches) {
  const parent = branches.find((b) => b.default) ?? branches.find((b) => b.primary)
  if (!parent) throw new Error('Could not identify the default (production) branch.')
  return parent
}

/**
 * A connection URI for a branch.
 *
 * Retries because a freshly created endpoint takes a moment to become routable
 * — a branch can exist and still refuse connections for several seconds.
 */
export async function connectionUri(
  apiKey,
  projectId,
  branchId,
  { database, role, pooled },
) {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: database,
    role_name: role,
    pooled: String(pooled),
  })

  let lastError
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const { uri } = await api(apiKey, `/projects/${projectId}/connection_uri?${params}`)
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

/**
 * The pooled/direct pair must actually be pooled and direct.
 *
 * Asserted because the two are interchangeable to the eye and are NOT
 * interchangeable to drizzle-kit: DDL over a pooler can fail mid-run, and
 * `drizzle.config.ts` prefers the unpooled variable when both are present.
 */
export function assertEndpointShape(pooledUri, directUri) {
  if (!new URL(pooledUri).hostname.includes('-pooler')) {
    throw new Error('Expected a pooled host (containing "-pooler") for DATABASE_URL.')
  }
  if (new URL(directUri).hostname.includes('-pooler')) {
    throw new Error('Expected a direct host (no "-pooler") for DATABASE_URL_UNPOOLED.')
  }
}
