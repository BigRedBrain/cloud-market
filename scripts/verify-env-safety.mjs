/**
 * Environment and database-target safety, proved without a database.
 *
 *   node scripts/verify-env-safety.mjs
 *
 * WHAT THIS SUITE IS ABOUT
 *
 * Two failures, both of which end with a migration running against the wrong
 * database, and neither of which announces itself:
 *
 *   1. A UTF-8 BOM at the top of `.env.local`. Node's `--env-file` parser does
 *      not strip it, so the FIRST variable in the file is set under a name
 *      containing an invisible character. `process.env.DATABASE_URL` is
 *      `undefined`; a dump of `process.env` shows something that looks exactly
 *      like `DATABASE_URL`. Under `DATABASE_URL_UNPOOLED ?? DATABASE_URL` the
 *      result is not an error — it is a silent fallback to another database.
 *
 *   2. A pooled/direct pair that is missing a half, swapped, or drawn from two
 *      different branches. The last of those is the accident this project has
 *      already had: `.env.local` supplying a development `DATABASE_URL_UNPOOLED`
 *      beside a production `DATABASE_URL`.
 *
 * Every case below is fail-closed: the assertion is that a problem is REPORTED,
 * never that a warning is printed. A warning an operator may proceed past is not
 * a control.
 *
 * AND ONE PROPERTY THAT MATTERS AS MUCH AS THE RULES: §E asserts that no message
 * this tooling produces ever contains a connection string, a hostname, a
 * username or a password. These functions run in the same shell as a production
 * credential and their output is pasted into runbooks.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  environmentProblems,
  isMangledKey,
  loadEnvFile,
  mangledEnvKeys,
  parseEnvText,
  stripBom,
} from './lib/env-file.mjs'
import {
  endpointFingerprint,
  evaluateConnectionShape,
  evaluateDatabaseTarget,
  evaluateIdentity,
  hostFingerprint,
  isPooledUrl,
  KNOWN_FINGERPRINTS,
  redactSecrets,
} from './lib/database-target.mjs'

let pass = 0
let fail = 0
const failures = []

const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
  }
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n${title}`)

const BOM = '﻿'

/**
 * Synthetic connection strings.
 *
 * Fabricated, not copied: nothing real is needed to test the shape rules, and a
 * test fixture is exactly the wrong place for a credential. The passwords below
 * are the tripwires §E looks for in the output.
 */
const PASSWORD = 'npg_ThisIsNotARealPassword'
const url = (endpoint, { pooled = false, host = 'eu-central-1.aws.neon.tech' } = {}) =>
  `postgresql://cloudmarket_owner:${PASSWORD}@${endpoint}${pooled ? '-pooler' : ''}.${host}/neondb?sslmode=require`

const PROD = { pooled: url('ep-prod-abc', { pooled: true }), direct: url('ep-prod-abc') }
const DEV = { pooled: url('ep-dev-xyz', { pooled: true }), direct: url('ep-dev-xyz') }
const COPY = { pooled: url('ep-copy-123', { pooled: true }), direct: url('ep-copy-123') }

console.log('Environment and database-target safety')

/* ========================================================== A. THE BOM ==== */
section('[A] A UTF-8 BOM cannot silently drop the first variable')
{
  check('stripBom removes a leading BOM', stripBom(`${BOM}A=1`) === 'A=1')
  check('stripBom leaves clean text alone', stripBom('A=1') === 'A=1')

  /**
   * The parser is the fix for a file we read ourselves. The guard below is the
   * fix for a file NODE read before our code ran, which is the case that
   * actually bites: by then the damage is in `process.env` and unrepairable.
   */
  const parsed = parseEnvText(`${BOM}DATABASE_URL=postgres://a\nSECOND=two\n`)
  check('the first variable survives a BOM', parsed.DATABASE_URL === 'postgres://a')
  check('later variables are unaffected', parsed.SECOND === 'two')
  check('no BOM-prefixed key is created', !Object.keys(parsed).some(isMangledKey))

  const mangled = { [`${BOM}DATABASE_URL`]: PROD.pooled, OTHER: 'x' }
  check('a BOM-mangled key is detected in a live environment', mangledEnvKeys(mangled).length === 1)
  check(
    'the report names the variable that was eaten',
    mangledEnvKeys(mangled)[0].intended === 'DATABASE_URL',
  )
  check('a clean environment reports nothing', environmentProblems({ DATABASE_URL: 'x' }).length === 0)

  /** The same class of invisible damage, arriving by copy-paste rather than by editor. */
  check('a non-breaking space in a key is caught', isMangledKey('DATABASE URL'))
  check('a trailing space in a key is caught', isMangledKey('DATABASE_URL '))
  check('an ordinary key is not', !isMangledKey('DATABASE_URL_UNPOOLED'))

  /** End to end, through a real file on disk, because that is how it arrives. */
  const dir = mkdtempSync(join(tmpdir(), 'cm-env-'))
  const path = join(dir, '.env.bom')
  writeFileSync(path, `${BOM}DATABASE_URL=${PROD.pooled}\nDATABASE_URL_UNPOOLED=${PROD.direct}\n`, 'utf8')
  const env = {}
  loadEnvFile(path, { env })
  check('loadEnvFile reads a BOM file correctly', env.DATABASE_URL === PROD.pooled)
  check('loadEnvFile does not create a mangled key', !Object.keys(env).some(isMangledKey))

  /** A shell export must always beat a file, or the gate's premise collapses. */
  const exported = { DATABASE_URL: PROD.pooled }
  writeFileSync(join(dir, '.env.dev'), `DATABASE_URL=${DEV.pooled}\n`, 'utf8')
  loadEnvFile(join(dir, '.env.dev'), { env: exported })
  check('an exported variable is not overwritten by a file', exported.DATABASE_URL === PROD.pooled)

  check('a missing file is not an error', loadEnvFile(join(dir, 'nope.env'), { env: {} }).loaded === false)
}

/* ============================================ B. FINGERPRINT PRIMITIVES === */
section('[B] Fingerprints identify a database without disclosing one')
{
  check(
    'the pooled and direct strings of one branch share an endpoint fingerprint',
    endpointFingerprint(PROD.pooled) === endpointFingerprint(PROD.direct),
  )
  check(
    'they do NOT share a host fingerprint',
    hostFingerprint(PROD.pooled) !== hostFingerprint(PROD.direct),
  )
  check(
    'different branches have different endpoint fingerprints',
    endpointFingerprint(PROD.pooled) !== endpointFingerprint(DEV.pooled),
  )
  check('a fingerprint is 12 hex characters', /^[0-9a-f]{12}$/.test(hostFingerprint(PROD.pooled)))
  check('a fingerprint discloses no hostname', !hostFingerprint(PROD.pooled).includes('prod'))
  check('an unparseable string yields null, not a throw', hostFingerprint('not a url') === null)

  check('the pooler is recognised', isPooledUrl(PROD.pooled))
  check('the direct endpoint is not mistaken for one', !isPooledUrl(PROD.direct))

  /**
   * The published fingerprints are load-bearing: `/api/health` computes the same
   * value, and rehearsal mode refuses on them when the network is unreachable.
   * Asserted literally so a well-meaning refactor of the digest is a failing
   * test rather than a gate that silently stops recognising production.
   */
  const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)
  check('the fingerprint function is SHA-256, first 12 hex', hostFingerprint(PROD.pooled) === digest(new URL(PROD.pooled).hostname))
  check('production host fingerprint is unchanged', KNOWN_FINGERPRINTS.productionHost === '2b968b3cbe06')
  check('production endpoint fingerprint is unchanged', KNOWN_FINGERPRINTS.productionEndpoint === 'b5d55740bd22')
  check('development endpoint fingerprint is unchanged', KNOWN_FINGERPRINTS.developmentEndpoint === 'a5d81ac199d8')
}

/* ================================================ C. THE PAIR, BY SHAPE === */
section('[C] The pooled/direct pair fails closed on every wrong shape')
{
  const shape = (pooledUrl, directUrl) => evaluateConnectionShape({ pooledUrl, directUrl })

  check('a correct pair passes', shape(PROD.pooled, PROD.direct).length === 0, shape(PROD.pooled, PROD.direct).join('; '))

  check(
    'DATABASE_URL missing is refused',
    shape(undefined, PROD.direct).some((p) => p.includes('DATABASE_URL is not set')),
  )
  check(
    'DATABASE_URL_UNPOOLED missing is refused',
    shape(PROD.pooled, undefined).some((p) => p.includes('DATABASE_URL_UNPOOLED is not set')),
  )
  check('both missing is refused', shape(undefined, undefined).length === 2)

  check(
    'a swapped pair is refused, naming the swap',
    shape(PROD.direct, PROD.pooled).some((p) => p.includes('swapped')),
  )
  check(
    'a direct string that is really pooled is refused',
    shape(PROD.pooled, PROD.pooled).some((p) => p.includes('addresses the POOLER')),
  )
  check(
    'a pooled string that is really direct is refused',
    shape(PROD.direct, PROD.direct).some((p) => p.includes('does NOT address the pooler')),
  )

  /** THE ONE THIS PROJECT HAS ACTUALLY HIT. */
  check(
    'a pair drawn from two different branches is refused',
    shape(PROD.pooled, DEV.direct).some((p) => p.includes('DIFFERENT Neon endpoints')),
  )

  check(
    'a non-postgres string is refused',
    shape('https://example.test', PROD.direct).some((p) => p.includes('postgres://')),
  )
  check('a value that is not a URL at all is refused', shape('garbage', PROD.direct).length > 0)
}

/* =================================== D. THE WHOLE DECISION, PER MODE ====== */
section('[D] The mode decides which database may be written to')
{
  const decide = (mode, env, live = null, environment = null) =>
    evaluateDatabaseTarget({ mode, env, liveFingerprint: live, liveEnvironment: environment })

  const prodEnv = {
    DATABASE_URL: PROD.pooled,
    DATABASE_URL_UNPOOLED: PROD.direct,
    PRODUCTION_POOLED_URL: PROD.pooled,
  }
  const livePool = hostFingerprint(PROD.pooled)

  check(
    'production mode accepts production when the live app agrees',
    decide('production', prodEnv, livePool, 'production').problems.length === 0,
    decide('production', prodEnv, livePool, 'production').problems.join('; '),
  )
  check(
    'production mode refuses when /api/health could not be read',
    decide('production', prodEnv, null, null).problems.some((p) => p.includes('nothing anchors')),
  )
  check(
    'production mode refuses without PRODUCTION_POOLED_URL',
    decide('production', { DATABASE_URL: PROD.pooled, DATABASE_URL_UNPOOLED: PROD.direct }, livePool, 'production')
      .problems.some((p) => p.includes('PRODUCTION_POOLED_URL is not set')),
  )
  check(
    'production mode refuses an anchor for a different database',
    decide('production', { ...prodEnv, PRODUCTION_POOLED_URL: COPY.pooled }, livePool, 'production')
      .problems.some((p) => p.includes('different databases')),
  )

  /**
   * The BOM case, end to end, at the level the operator experiences it: the
   * variable is "set" and the gate still refuses.
   */
  const bomEnv = {
    [`${BOM}DATABASE_URL`]: PROD.pooled,
    DATABASE_URL_UNPOOLED: PROD.direct,
    PRODUCTION_POOLED_URL: PROD.pooled,
  }
  const bomDecision = decide('production', bomEnv, livePool, 'production')
  check('a BOM-mangled environment is refused outright', bomDecision.problems.length > 0)
  check(
    'the refusal explains the BOM rather than blaming the operator',
    bomDecision.problems.some((p) => p.includes('BOM')),
  )
  check(
    'and it also reports the missing variable',
    bomDecision.problems.some((p) => p.includes('DATABASE_URL is not set')),
  )

  /** REHEARSAL: an isolated copy, and nothing else. */
  const copyEnv = { DATABASE_URL: COPY.pooled, DATABASE_URL_UNPOOLED: COPY.direct }
  check(
    'rehearsal mode accepts an isolated copy',
    decide('rehearsal', copyEnv, livePool, 'production').problems.length === 0,
    decide('rehearsal', copyEnv, livePool, 'production').problems.join('; '),
  )
  check(
    'rehearsal mode refuses the live production database',
    decide('rehearsal', { DATABASE_URL: PROD.pooled, DATABASE_URL_UNPOOLED: PROD.direct }, livePool, 'production')
      .problems.some((p) => p.includes('IS the database the live application is using')),
  )
  check(
    'rehearsal mode needs no PRODUCTION_POOLED_URL',
    !decide('rehearsal', copyEnv, null, null).problems.some((p) => p.includes('PRODUCTION_POOLED_URL')),
  )
  check(
    'rehearsal mode still refuses a half pair',
    decide('rehearsal', { DATABASE_URL: COPY.pooled }, null, null).problems.some((p) =>
      p.includes('DATABASE_URL_UNPOOLED is not set'),
    ),
  )

  /**
   * The KNOWN-fingerprint refusals cannot be driven from a URL — no synthetic
   * hostname digests to the published production fingerprint, and inventing one
   * would mean weakening the digest. They are fed to the identity function
   * directly, which is also where `verify-migration-target-modes.mjs` exercises
   * the two modes against each other in depth. Two cases are repeated here
   * because they are new: production mode must refuse DEVELOPMENT, which
   * previously it caught only indirectly through the anchor comparison.
   */
  const identity = (mode, host, endpoint) =>
    evaluateIdentity({
      mode,
      resolvedHost: host,
      resolvedEndpoint: endpoint,
      pooledHost: host,
      pooledEndpoint: endpoint,
      liveFingerprint: null,
      liveEnvironment: null,
    })

  check(
    'production mode refuses the known development database even with no health probe',
    identity(
      'production',
      KNOWN_FINGERPRINTS.developmentHosts[0],
      KNOWN_FINGERPRINTS.developmentEndpoint,
    ).some((p) => p.includes('known development fingerprint')),
  )
  check(
    'production mode refuses anything on the known development endpoint',
    identity('production', 'aaaaaaaaaaaa', KNOWN_FINGERPRINTS.developmentEndpoint).some((p) =>
      p.includes('known development endpoint'),
    ),
  )
  check(
    'rehearsal mode refuses the known production database with no health probe',
    identity(
      'rehearsal',
      KNOWN_FINGERPRINTS.productionHost,
      KNOWN_FINGERPRINTS.productionEndpoint,
    ).some((p) => p.includes('known production fingerprint')),
  )
}

/* ====================================== E. NOTHING LEAKS INTO A MESSAGE === */
section('[E] No message ever contains a credential, host or connection string')
{
  const everyProblem = [
    ...evaluateConnectionShape({ pooledUrl: PROD.direct, directUrl: PROD.pooled }),
    ...evaluateConnectionShape({ pooledUrl: 'garbage', directUrl: PROD.direct }),
    ...evaluateConnectionShape({ pooledUrl: PROD.pooled, directUrl: DEV.direct }),
    ...evaluateDatabaseTarget({
      mode: 'production',
      env: { [`${BOM}DATABASE_URL`]: PROD.pooled, DATABASE_URL_UNPOOLED: DEV.direct },
      liveFingerprint: null,
      liveEnvironment: null,
    }).problems,
    ...evaluateDatabaseTarget({
      mode: 'rehearsal',
      env: { DATABASE_URL: PROD.pooled, DATABASE_URL_UNPOOLED: PROD.direct },
      liveFingerprint: hostFingerprint(PROD.pooled),
      liveEnvironment: 'production',
    }).problems,
  ].join('\n')

  check('no password appears in any message', !everyProblem.includes(PASSWORD))
  check('no username appears in any message', !everyProblem.includes('cloudmarket_owner'))
  check('no hostname appears in any message', !everyProblem.includes('neon.tech'))
  /**
   * `postgres://` DOES appear in one message — "is not a postgres:// or
   * postgresql:// connection string", which is guidance about a scheme, not a
   * disclosure. What must never appear is a string with something after the
   * scheme: any `…://…@…` is credentials.
   */
  check(
    'no connection string appears in any message',
    ![PROD, DEV, COPY].some(({ pooled, direct }) =>
      everyProblem.includes(pooled) || everyProblem.includes(direct),
    ),
  )
  check('no scheme in any message is followed by a credential', !/:\/\/\S*@/.test(everyProblem))
  check(
    'no endpoint id appears in any message',
    !everyProblem.includes('ep-prod-abc') && !everyProblem.includes('ep-dev-xyz'),
  )

  /** Third-party error text is redacted before it is printed. */
  check(
    'a DNS failure is redacted',
    redactSecrets('getaddrinfo ENOTFOUND ep-prod-abc.eu-central-1.aws.neon.tech').includes('[host redacted]'),
  )
  check(
    'an authentication failure does not name the role',
    !redactSecrets('password authentication failed for user "cloudmarket_app"').includes('cloudmarket_app'),
  )
  check(
    'a quoted connection string is redacted',
    redactSecrets(`could not connect to ${PROD.pooled}`).includes('[connection string redacted]'),
  )
  check('redaction leaves ordinary text intact', redactSecrets('relation does not exist') === 'relation does not exist')
}

/* ========================================================== summary ====== */
console.log('\n==========================================================')
if (fail === 0) {
  console.log(`RESULT: ${pass} passed, 0 failed`)
} else {
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  for (const f of failures) console.log(`  • ${f}`)
  process.exitCode = 1
}
console.log('==========================================================')
