/**
 * Development credential rotation check.
 *
 *   node scripts/verify-dev-credential.mjs
 *
 * Run AFTER rotating the development role's password in Neon and updating
 * `.env.local` with the new pooled and direct strings.
 *
 * PRINTS NO CREDENTIAL. Every value is reduced to a 12-character SHA-256
 * fingerprint before it is shown — enough to compare two things, useless for
 * connecting to anything.
 *
 * Optional, and worth supplying — each unlocks a stronger assertion:
 *
 *   OLD_DATABASE_URL       the pre-rotation development string. Proves the old
 *                          credential is actually REJECTED rather than merely
 *                          replaced in a file.
 *   PRODUCTION_POOLED_URL  the production pooled string. Proves the new
 *                          development password cannot authenticate against
 *                          production, by trying it there and requiring failure.
 *
 * Without them the script still checks everything it can and says plainly which
 * assertions it could not make, rather than implying full coverage.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const h12 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)
/**
 * Validate the SHAPE before fingerprinting it. `new URL()` on a placeholder
 * throws ERR_INVALID_URL from deep inside Node, which reads like a bug in this
 * script rather than an unset variable. This is the third time a configuration
 * mistake has surfaced as a stack trace; it should surface as a sentence.
 */
function requireConnectionString(value, name = 'DATABASE_URL') {
  if (!value) {
    console.error(`${name} is not set.\n` +
      `  PowerShell:  $env:${name} = "postgresql://…"\n` +
      `  bash:        export ${name}="postgresql://…"`)
    process.exit(1)
  }
  if (!/^postgres(ql)?:\/\//.test(value)) {
    console.error(`${name} does not look like a connection string.\n` +
      `  It currently starts with: ${value.slice(0, 24)}…\n` +
      `  Expected something beginning postgresql:// — if you copied the command\n` +
      `  from the docs, replace the placeholder with the real value.`)
    process.exit(1)
  }
  return value
}

const hostFp = (url) => h12(new URL(url).hostname)
const endpointFp = (url) => h12(new URL(url).hostname.split('.')[0].replace('-pooler', ''))
const secretFp = (url) => h12(new URL(url).password)

/** Known constants. Fingerprints only — none of these is usable as a secret. */
const DEV_ENDPOINT_FP = 'a5d81ac199d8'
const PRODUCTION_HOST_FP = '2b968b3cbe06'
/** The development password that leaked during debugging. Must never come back. */
const EXPOSED_SECRET_FP = '67c25d76c19c'

let passed = 0
let failed = 0
const failures = []
const skipped = []
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const skip = (name, why) => {
  skipped.push(name)
  console.log(`  skip  ${name} — ${why}`)
}

/** Attempts one query. Returns what happened, never throws. */
async function tryConnect(connectionString) {
  const pool = new Pool({ connectionString })
  try {
    const result = await pool.query('select current_database() db, current_user usr')
    return { ok: true, db: result.rows[0].db, role: result.rows[0].usr }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    await pool.end().catch(() => {})
  }
}

/** Is this an authentication rejection, as opposed to the host being down? */
const isAuthFailure = (message = '') =>
  /password|authentication|auth failed|role .* does not exist|permission denied/i.test(message)

async function main() {
  console.log('Development credential rotation check\n')

  const pooled = process.env.DATABASE_URL
  const direct = process.env.DATABASE_URL_UNPOOLED

  requireConnectionString(pooled, 'DATABASE_URL')
  requireConnectionString(direct, 'DATABASE_URL_UNPOOLED')

  console.log('[1] Identity of the configured strings')
  console.log(`  pooled   host ${hostFp(pooled)}  endpoint ${endpointFp(pooled)}  secret ${secretFp(pooled)}`)
  console.log(`  direct   host ${hostFp(direct)}  endpoint ${endpointFp(direct)}  secret ${secretFp(direct)}`)

  check('both strings target the DEVELOPMENT endpoint',
    endpointFp(pooled) === DEV_ENDPOINT_FP && endpointFp(direct) === DEV_ENDPOINT_FP,
    `${endpointFp(pooled)} / ${endpointFp(direct)}`)
  check('neither string is the production host',
    hostFp(pooled) !== PRODUCTION_HOST_FP && hostFp(direct) !== PRODUCTION_HOST_FP)
  check('pooled and direct share one credential',
    secretFp(pooled) === secretFp(direct))

  console.log('\n[2] The exposed credential is gone')
  check('the rotated-away password is NOT in .env.local',
    secretFp(pooled) !== EXPOSED_SECRET_FP && secretFp(direct) !== EXPOSED_SECRET_FP,
    'still the credential that leaked during debugging')

  console.log('\n[3] The new credential works, and only where it should')
  const newPooled = await tryConnect(pooled)
  check('new credential connects on the pooled endpoint', newPooled.ok,
    newPooled.ok ? '' : newPooled.message.slice(0, 90))
  check('it reaches the cloudmarket database', newPooled.db === 'cloudmarket',
    newPooled.db ?? 'n/a')

  const newDirect = await tryConnect(direct)
  check('new credential connects on the direct endpoint', newDirect.ok,
    newDirect.ok ? '' : newDirect.message.slice(0, 90))

  if (newPooled.ok) {
    const pool = new Pool({ connectionString: pooled })
    try {
      const [{ products }] = (await pool.query(
        'select (select count(*)::int from products) as products')).rows
      /**
       * A data signature, not just a successful handshake. Development carries
       * the seeded catalog; production's is empty. Connecting to "a" database
       * proves less than connecting to the RIGHT one.
       */
      check('the data signature is development (seeded catalog present)', products > 0,
        `${products} products — production's catalog is empty`)
    } finally {
      await pool.end().catch(() => {})
    }
  }

  console.log('\n[4] The old credential is rejected')
  const oldUrl = process.env.OLD_DATABASE_URL
  if (!oldUrl) {
    skip('old credential is actively rejected',
      'set OLD_DATABASE_URL to the pre-rotation string to prove this')
  } else {
    check('the supplied old string really is the exposed one',
      secretFp(oldUrl) === EXPOSED_SECRET_FP,
      `secret fp ${secretFp(oldUrl)}`)
    const old = await tryConnect(oldUrl)
    check('the old credential can no longer authenticate', !old.ok,
      old.ok ? 'IT STILL WORKS — rotation did not take effect' : '')
    if (!old.ok) {
      check('and it fails on authentication, not on reachability',
        isAuthFailure(old.message), old.message.slice(0, 90))
    }
  }

  console.log('\n[5] The new credential cannot reach production')
  const prodUrl = process.env.PRODUCTION_POOLED_URL
  if (!prodUrl) {
    skip('new credential is refused by production',
      'set PRODUCTION_POOLED_URL to prove this directly')
    console.log('        (structural argument: Neon role passwords are per-branch — a')
    console.log('         branch is a copy-on-write clone including pg_authid — so a')
    console.log('         development password is not a production password. The direct')
    console.log('         test is still worth doing.)')
  } else {
    check('the supplied production string is the production host',
      hostFp(prodUrl) === PRODUCTION_HOST_FP, hostFp(prodUrl))

    /** The new development password, aimed at the production host. */
    const crossed = new URL(prodUrl)
    crossed.password = new URL(pooled).password
    const cross = await tryConnect(crossed.toString())
    check('the development password is REJECTED by production', !cross.ok,
      cross.ok ? 'IT CONNECTED — branches are not isolated' : '')
    if (!cross.ok) {
      check('and production rejects it on authentication', isAuthFailure(cross.message),
        cross.message.slice(0, 90))
    }
  }

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${skipped.length} skipped`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}`)
  console.log('==========================================================')
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
