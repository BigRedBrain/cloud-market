/**
 * Where a migration is about to write, decided as a pure function.
 *
 * WHY THE LOGIC LIVES HERE AND NOT IN THE SCRIPT THAT USES IT
 *
 * `scripts/verify-migration-target.mjs` is the operator-facing gate: it loads
 * the environment, opens a connection, reads the journal, prints a report. None
 * of that can be exercised in CI, because all of it needs a database and one of
 * the answers it must give correctly is "this is production, stop". A gate whose
 * decision cannot be tested is a gate nobody can trust after the third time it
 * is edited.
 *
 * So every DECISION lives in this module as a pure function of strings, and the
 * script is reduced to gathering inputs and printing the verdict.
 * `scripts/verify-env-safety.mjs` and `scripts/verify-migration-target-modes.mjs`
 * then prove the decisions without a database, a network or a credential.
 *
 * THE ONE RULE THIS MODULE NEVER BREAKS
 *
 * NO CONNECTION STRING, HOSTNAME, USERNAME OR PASSWORD IS EVER RETURNED,
 * LOGGED, OR EMBEDDED IN A PROBLEM MESSAGE. Databases are identified by a
 * FINGERPRINT: the first 12 hex characters of the SHA-256 of the hostname (or of
 * the endpoint id with `-pooler` stripped). That is enough to say "these two
 * strings are the same database" and "this is the known production database",
 * and not enough to connect to anything. Every one of these functions may be run
 * in a shell that currently holds a production credential; that is the point.
 */
import { createHash } from 'node:crypto'

import { environmentProblems } from './env-file.mjs'

/**
 * Known identities, so a rehearsal can be refused for pointing at production or
 * development even when `/api/health` is unreachable.
 */
export const KNOWN_FINGERPRINTS = {
  productionHost: '2b968b3cbe06',
  productionEndpoint: 'b5d55740bd22',
  developmentHosts: ['eec6912eb35b', '3c503c1409d2'],
  developmentEndpoint: 'a5d81ac199d8',
}

/** Neon marks a pooled endpoint by suffixing the endpoint id, not the domain. */
const POOLER_MARKER = '-pooler'

/**
 * Removes anything identifying from a message written by somebody else.
 *
 * Driver and DNS errors quote their input: `getaddrinfo ENOTFOUND
 * ep-xxx-yyy.eu-central-1.aws.neon.tech` names the branch, and
 * `password authentication failed for user "cloudmarket_app"` names the role.
 * Those messages are useful and are worth printing — after this.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return String(text)
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection string redacted]')
    .replace(/\b[\w.-]*\.neon\.tech\b/gi, '[host redacted]')
    .replace(/\bfor user "[^"]*"/gi, 'for user [redacted]')
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** Hostname of a connection string, or null if it is not a URL at all. */
function hostnameOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    /**
     * The parse error is swallowed rather than reported. Node embeds the input
     * in `error.input`, and some formatters print it — which would put a
     * credential in a log written by the tool whose entire job is to keep it out
     * of one.
     */
    return null
  }
}

/** Fingerprint of the full hostname. Identifies one database. */
export function hostFingerprint(url) {
  const hostname = hostnameOf(url)
  return hostname === null ? null : digest(hostname)
}

/**
 * Fingerprint of the Neon endpoint, with `-pooler` stripped.
 *
 * Identifies one BRANCH: the pooled and direct strings for the same branch
 * share this value, which is what makes "are these two strings the same
 * database?" answerable without comparing the strings.
 */
export function endpointFingerprint(url) {
  const hostname = hostnameOf(url)
  if (hostname === null) return null
  return digest(hostname.split('.')[0].replace(POOLER_MARKER, ''))
}

/** Does this string address a connection pooler? */
export function isPooledUrl(url) {
  const hostname = hostnameOf(url)
  return hostname === null ? false : hostname.split('.')[0].includes(POOLER_MARKER)
}

/** Does this look like a Postgres connection string at all? */
export function isPostgresUrl(url) {
  if (typeof url !== 'string') return false
  return url.startsWith('postgres://') || url.startsWith('postgresql://')
}

/* -------------------------------------------------------------------------- */
/* The pair                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Checks the SHAPE of the pooled/direct pair, before anything is connected to.
 *
 * Every rule here exists because the failure it catches has a plausible route
 * into a real rollout:
 *
 *   MISSING DIRECT — `drizzle.config.ts` falls back to `DATABASE_URL`, so DDL
 *   runs over a pooler. PgBouncer in transaction mode can drop the session
 *   between statements, which fails a migration halfway through with some
 *   statements committed. Previously this was a warning; a warning is not a
 *   control.
 *
 *   MISSING POOLED — the pair cannot be cross-checked at all, so nothing proves
 *   the direct string belongs to the branch the application actually uses. The
 *   gate refuses rather than verifying half a pair.
 *
 *   DIRECT IS POOLED / POOLED IS NOT POOLED — the two strings were swapped.
 *   They are two long, nearly identical URLs differing by seven characters in
 *   the middle, and pasting them the wrong way round is the single easiest
 *   mistake available at this step. Both orderings are caught.
 *
 *   DIFFERENT ENDPOINTS — the strings are from DIFFERENT BRANCHES. This is the
 *   exact shape of the accident this whole gate exists for: `.env.local`
 *   silently supplying a development `DATABASE_URL_UNPOOLED` beside a
 *   production `DATABASE_URL`, so the migration runs on development while every
 *   surrounding check passes.
 *
 * @param {object} input
 * @param {string|null|undefined} input.pooledUrl
 * @param {string|null|undefined} input.directUrl
 * @param {string} [input.pooledLabel]  variable name, for the message
 * @param {string} [input.directLabel]
 * @returns {string[]} problems; empty means the shape is sound
 */
export function evaluateConnectionShape({
  pooledUrl,
  directUrl,
  pooledLabel = 'DATABASE_URL',
  directLabel = 'DATABASE_URL_UNPOOLED',
}) {
  const problems = []

  if (!pooledUrl) {
    problems.push(
      `${pooledLabel} is not set. It is the pooled half of the pair, and without it ` +
        'nothing cross-checks the string the migration will actually open.',
    )
  }
  if (!directUrl) {
    problems.push(
      `${directLabel} is not set. drizzle-kit would fall back to the pooled string, and ` +
        'DDL over a pooled endpoint can fail part-applied.',
    )
  }
  if (!pooledUrl || !directUrl) return problems

  if (!isPostgresUrl(pooledUrl)) {
    problems.push(`${pooledLabel} is not a postgres:// or postgresql:// connection string.`)
  }
  if (!isPostgresUrl(directUrl)) {
    problems.push(`${directLabel} is not a postgres:// or postgresql:// connection string.`)
  }

  const pooledHost = hostFingerprint(pooledUrl)
  const directHost = hostFingerprint(directUrl)
  if (pooledHost === null) problems.push(`${pooledLabel} could not be parsed as a URL.`)
  if (directHost === null) problems.push(`${directLabel} could not be parsed as a URL.`)
  if (problems.length > 0) return problems

  if (isPooledUrl(directUrl)) {
    problems.push(
      `${directLabel} addresses the POOLER. Migrations must use the direct endpoint — ` +
        `it looks as though ${directLabel} and ${pooledLabel} were swapped.`,
    )
  }
  if (!isPooledUrl(pooledUrl)) {
    problems.push(
      `${pooledLabel} does NOT address the pooler. The application connects through the ` +
        `pooler, so this is either the direct string in the wrong variable, or a ` +
        'string for a database the application does not use.',
    )
  }

  if (endpointFingerprint(pooledUrl) !== endpointFingerprint(directUrl)) {
    problems.push(
      `${pooledLabel} and ${directLabel} are on DIFFERENT Neon endpoints ` +
        `(${endpointFingerprint(pooledUrl)} vs ${endpointFingerprint(directUrl)}). ` +
        'They must be the pooled and direct strings for ONE branch. This is the exact ' +
        'shape of a .env.local development string sitting beside a production one.',
    )
  }

  return problems
}

/* -------------------------------------------------------------------------- */
/* The identity                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The identity decision, as a pure function of fingerprints.
 *
 * @param {object} input
 * @param {'production'|'rehearsal'} input.mode
 * @param {string} input.resolvedHost      hostFingerprint of the string drizzle-kit will open
 * @param {string} input.resolvedEndpoint  endpointFingerprint of the same
 * @param {string} input.pooledHost        hostFingerprint of the pooled string
 * @param {string} input.pooledEndpoint    endpointFingerprint of the same
 * @param {string|null} input.liveFingerprint  what /api/health published, or null
 * @param {string|null} input.liveEnvironment  what /api/health called itself, or null
 * @returns {string[]} problems; empty means the identity checks passed
 */
export function evaluateIdentity({
  mode,
  resolvedHost,
  resolvedEndpoint,
  pooledHost,
  pooledEndpoint,
  liveFingerprint,
  liveEnvironment,
}) {
  const problems = []

  /* ---- A. both strings must be the same Neon branch, in BOTH modes ------- */
  if (resolvedEndpoint !== pooledEndpoint) {
    problems.push(
      'The resolved write target is a DIFFERENT Neon branch than the pooled string. ' +
        'This is the exact shape of an accidental write to development.',
    )
  }

  if (mode === 'production') {
    /* ---- B. must BE the database the live application is using ----------- */
    if (liveFingerprint === null) {
      problems.push('Could not read the live application fingerprint, so nothing anchors this target.')
    } else if (liveFingerprint !== pooledHost) {
      problems.push(
        'The pooled string is not the database the deployed app is using, so it ' +
          'cannot anchor anything. Both strings may be wrong.',
      )
    }
    if (liveEnvironment !== null && liveEnvironment !== 'production') {
      problems.push(`The app reports environment "${liveEnvironment}", not "production".`)
    }

    /**
     * A production rollout that resolves to the DEVELOPMENT database is the
     * mirror image of a rehearsal that resolves to production, and it was
     * previously caught only indirectly — by the anchor comparison, which
     * assumes `/api/health` was reachable. Named explicitly so the refusal says
     * what is wrong rather than "not anchored".
     */
    for (const [label, fp] of [
      ['resolved write target', resolvedHost],
      ['pooled string', pooledHost],
    ]) {
      if (KNOWN_FINGERPRINTS.developmentHosts.includes(fp)) {
        problems.push(`The ${label} matches the known development fingerprint.`)
      }
    }
    for (const [label, fp] of [
      ['resolved write target', resolvedEndpoint],
      ['pooled string', pooledEndpoint],
    ]) {
      if (fp === KNOWN_FINGERPRINTS.developmentEndpoint) {
        problems.push(`The ${label} is on the known development endpoint.`)
      }
    }

    return problems
  }

  /* ---- B (inverted). must NOT be production, and must not be development - */
  for (const [label, fp] of [
    ['resolved write target', resolvedHost],
    ['pooled string', pooledHost],
  ]) {
    if (liveFingerprint !== null && fp === liveFingerprint) {
      problems.push(
        `The ${label} IS the database the live application is using. A rehearsal ` +
          'must never be run against production.',
      )
    }
    if (fp === KNOWN_FINGERPRINTS.productionHost) {
      problems.push(`The ${label} matches the known production fingerprint.`)
    }
    if (KNOWN_FINGERPRINTS.developmentHosts.includes(fp)) {
      problems.push(
        `The ${label} matches the known development fingerprint. A rehearsal must ` +
          'be an isolated copy of production, not the development database.',
      )
    }
  }
  for (const [label, fp] of [
    ['resolved write target', resolvedEndpoint],
    ['pooled string', pooledEndpoint],
  ]) {
    if (fp === KNOWN_FINGERPRINTS.productionEndpoint) {
      problems.push(`The ${label} is on the known production endpoint.`)
    }
    if (fp === KNOWN_FINGERPRINTS.developmentEndpoint) {
      problems.push(`The ${label} is on the known development endpoint.`)
    }
  }

  return problems
}

/* -------------------------------------------------------------------------- */
/* The whole decision                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything that can be decided from the environment alone.
 *
 * Runs, in order and always fail-closed:
 *
 *   1. the environment is readable at all (no BOM-mangled variable names)
 *   2. the pooled/direct pair exists and is the right way round
 *   3. the pair is one branch
 *   4. the branch is the one this MODE is allowed to write to
 *
 * `resolved` mirrors `drizzle.config.ts` exactly — `DATABASE_URL_UNPOOLED ??
 * DATABASE_URL` — so the answer is about the connection drizzle-kit will open,
 * not about the variable the operator believes they set.
 *
 * @param {object} input
 * @param {'production'|'rehearsal'} input.mode
 * @param {Record<string,string|undefined>} input.env
 * @param {string|null} [input.liveFingerprint]
 * @param {string|null} [input.liveEnvironment]
 * @returns {{problems: string[], resolvedFrom: string|null, fingerprints: object}}
 */
export function evaluateDatabaseTarget({
  mode,
  env,
  liveFingerprint = null,
  liveEnvironment = null,
}) {
  const directUrl = env.DATABASE_URL_UNPOOLED
  const pooledUrl = env.DATABASE_URL
  const anchorUrl = env.PRODUCTION_POOLED_URL

  /**
   * Kept separate from the rest, because the identity check below is only
   * MEANINGFUL on a sound pair — comparing two nulls would produce a PASS — but
   * it is still worth running when the only other complaint is a missing
   * anchor. An operator who forgot `PRODUCTION_POOLED_URL` while pointed at
   * development deserves to be told both things at once.
   */
  const shapeProblems = [
    ...environmentProblems(env),
    ...evaluateConnectionShape({ pooledUrl, directUrl }),
  ]
  const problems = [...shapeProblems]

  /**
   * In production mode the ANCHOR is supplied separately and deliberately: it is
   * the string `/api/health` validates against, and requiring the operator to
   * paste it explicitly is what stops `.env.local` from quietly providing one.
   * In a rehearsal there is no production credential in the room — and there
   * must not be — so the pair verifies itself.
   */
  if (mode === 'production' && !anchorUrl) {
    problems.push(
      'PRODUCTION_POOLED_URL is not set. It is the anchor /api/health is compared against; ' +
        'without it nothing proves these strings belong to the deployed application.',
    )
  }
  if (mode === 'production' && anchorUrl && pooledUrl) {
    if (hostFingerprint(anchorUrl) !== hostFingerprint(pooledUrl)) {
      problems.push(
        'PRODUCTION_POOLED_URL and DATABASE_URL are different databases. Set DATABASE_URL to ' +
          'the same production pooled string, so the pair being verified is the pair the ' +
          'application uses.',
      )
    }
  }

  const resolved = directUrl ?? pooledUrl
  const resolvedFrom = directUrl ? 'DATABASE_URL_UNPOOLED' : pooledUrl ? 'DATABASE_URL' : null

  const fingerprints = {
    resolvedHost: resolved ? hostFingerprint(resolved) : null,
    resolvedEndpoint: resolved ? endpointFingerprint(resolved) : null,
    pooledHost: pooledUrl ? hostFingerprint(pooledUrl) : null,
    pooledEndpoint: pooledUrl ? endpointFingerprint(pooledUrl) : null,
  }

  if (shapeProblems.length === 0) {
    problems.push(
      ...evaluateIdentity({
        mode,
        ...fingerprints,
        liveFingerprint,
        liveEnvironment,
      }),
    )
  }

  return { problems, resolvedFrom, fingerprints }
}
