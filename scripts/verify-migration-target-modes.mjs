/**
 * The two modes of the migration-target gate, proved against each other.
 *
 *   node scripts/verify-migration-target-modes.mjs
 *
 * Needs no database, no network and no credential: `evaluateIdentity` is a pure
 * function of fingerprints, which is the whole reason it was extracted. What
 * matters here is the EXPECTATION each mode encodes, not the plumbing that
 * gathers the inputs.
 *
 * THE CENTRAL PROPERTY
 *
 * Production mode and rehearsal mode must disagree about exactly one thing —
 * whether the target may be production — and agree about everything else. A
 * "rehearsal mode" that merely relaxed the check would be a way of ignoring a
 * NO-GO, which is precisely what this design refuses to provide. So the same
 * inputs are fed to both modes and the results are asserted to be opposite.
 */
import { evaluateIdentity, KNOWN_FINGERPRINTS } from './verify-migration-target.mjs'

let pass = 0
let fail = 0
const failures = []

const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else {
    fail += 1
    failures.push(name)
  }
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

const PROD = KNOWN_FINGERPRINTS.productionHost
const DEV = KNOWN_FINGERPRINTS.developmentHosts[0]
const DEV_DIRECT = KNOWN_FINGERPRINTS.developmentHosts[1]
const DEV_ENDPOINT = KNOWN_FINGERPRINTS.developmentEndpoint

/** A believable isolated copy: its own host and endpoint, matching nothing known. */
const COPY = { host: '48d2998d7060', direct: '033993dbfcb0', endpoint: 'a53081efb29d' }
/** Production's own endpoint, distinct from the copy's. */
const PROD_ENDPOINT = 'c0ffee111111'

const scenario = ({ mode, resolvedHost, resolvedEndpoint, pooledHost, pooledEndpoint, live = PROD, env = 'production' }) =>
  evaluateIdentity({
    mode,
    resolvedHost,
    resolvedEndpoint,
    pooledHost,
    pooledEndpoint,
    liveFingerprint: live,
    liveEnvironment: env,
  })

console.log('Migration-target gate — production vs rehearsal mode')

/* ============================================ 1. THE INVERSION ============ */
section('[1] The same target gets opposite answers in the two modes')
{
  /** Pointed at production: correct for a release, catastrophic for a rehearsal. */
  const atProduction = {
    resolvedHost: PROD, resolvedEndpoint: PROD_ENDPOINT,
    pooledHost: PROD, pooledEndpoint: PROD_ENDPOINT,
  }
  const prodModeAtProd = scenario({ mode: 'production', ...atProduction })
  const rehearsalModeAtProd = scenario({ mode: 'rehearsal', ...atProduction })

  check('production mode ACCEPTS the production database', prodModeAtProd.length === 0,
    prodModeAtProd.join('; '))
  check('rehearsal mode REFUSES the production database', rehearsalModeAtProd.length > 0)
  check('the refusal says it is the live database',
    rehearsalModeAtProd.some((p) => p.includes('IS the database the live application is using')))
  check('the refusal also names the known production fingerprint',
    rehearsalModeAtProd.some((p) => p.includes('known production fingerprint')))

  /** Pointed at an isolated copy: correct for a rehearsal, wrong for a release. */
  const atCopy = {
    resolvedHost: COPY.direct, resolvedEndpoint: COPY.endpoint,
    pooledHost: COPY.host, pooledEndpoint: COPY.endpoint,
  }
  const prodModeAtCopy = scenario({ mode: 'production', ...atCopy })
  const rehearsalModeAtCopy = scenario({ mode: 'rehearsal', ...atCopy })

  check('rehearsal mode ACCEPTS an isolated copy', rehearsalModeAtCopy.length === 0,
    rehearsalModeAtCopy.join('; '))
  check('production mode REFUSES an isolated copy', prodModeAtCopy.length > 0)
  check('the refusal says the pooled string is not what the app uses',
    prodModeAtCopy.some((p) => p.includes('not the database the deployed app is using')))
}

/* ================================= 2. SHARED CHECKS SURVIVE BOTH ========== */
section('[2] Every other identity check is retained in BOTH modes')
{
  /** A. the two strings must be one branch — mismatched endpoints. */
  const splitBrainProd = scenario({
    mode: 'production',
    resolvedHost: DEV_DIRECT, resolvedEndpoint: DEV_ENDPOINT,
    pooledHost: PROD, pooledEndpoint: PROD_ENDPOINT,
  })
  const splitBrainRehearsal = scenario({
    mode: 'rehearsal',
    resolvedHost: DEV_DIRECT, resolvedEndpoint: DEV_ENDPOINT,
    pooledHost: COPY.host, pooledEndpoint: COPY.endpoint,
  })
  check('production mode catches a direct string from another branch',
    splitBrainProd.some((p) => p.includes('DIFFERENT Neon branch')))
  check('rehearsal mode catches a direct string from another branch',
    splitBrainRehearsal.some((p) => p.includes('DIFFERENT Neon branch')))

  /**
   * This is the failure the whole gate was built for: `.env.local` silently
   * supplying a development DATABASE_URL_UNPOOLED. It must be caught in both
   * modes, and in rehearsal mode it must be named as development rather than
   * merely "not production".
   */
  const atDevelopment = {
    resolvedHost: DEV_DIRECT, resolvedEndpoint: DEV_ENDPOINT,
    pooledHost: DEV, pooledEndpoint: DEV_ENDPOINT,
  }
  const prodModeAtDev = scenario({ mode: 'production', ...atDevelopment })
  const rehearsalModeAtDev = scenario({ mode: 'rehearsal', ...atDevelopment })

  check('production mode refuses the development database', prodModeAtDev.length > 0)
  check('rehearsal mode refuses the development database', rehearsalModeAtDev.length > 0)
  check('rehearsal mode names it as development, not merely "not production"',
    rehearsalModeAtDev.some((p) => p.includes('known development fingerprint')))
  check('rehearsal mode also catches the development ENDPOINT',
    rehearsalModeAtDev.some((p) => p.includes('known development endpoint')))

  /**
   * A copy on the development endpoint is the subtle one: a fresh database
   * beside the development branch has its own hostname but shares the endpoint.
   * It is isolated from the development DATABASE, not from development.
   */
  const sameEndpointDifferentHost = scenario({
    mode: 'rehearsal',
    resolvedHost: 'aaaaaaaaaaaa', resolvedEndpoint: DEV_ENDPOINT,
    pooledHost: 'bbbbbbbbbbbb', pooledEndpoint: DEV_ENDPOINT,
  })
  check('rehearsal mode refuses a copy sharing the development endpoint',
    sameEndpointDifferentHost.some((p) => p.includes('known development endpoint')))
}

/* ============================ 3. A MISSING ANCHOR IS NOT A PASS ========== */
section('[3] An unreadable live fingerprint fails closed in production mode')
{
  const noHealth = scenario({
    mode: 'production',
    resolvedHost: PROD, resolvedEndpoint: PROD_ENDPOINT,
    pooledHost: PROD, pooledEndpoint: PROD_ENDPOINT,
    live: null, env: null,
  })
  check('production mode refuses when /api/health could not be read',
    noHealth.some((p) => p.includes('nothing anchors this target')))

  /**
   * Rehearsal mode must still work with the health endpoint unreachable — an
   * operator verifying an isolated copy may have no route to production at all.
   * The known-fingerprint constants carry the check on their own.
   */
  const rehearsalNoHealth = scenario({
    mode: 'rehearsal',
    resolvedHost: COPY.direct, resolvedEndpoint: COPY.endpoint,
    pooledHost: COPY.host, pooledEndpoint: COPY.endpoint,
    live: null, env: null,
  })
  check('rehearsal mode still passes an isolated copy without /api/health',
    rehearsalNoHealth.length === 0, rehearsalNoHealth.join('; '))

  const rehearsalNoHealthAtProd = scenario({
    mode: 'rehearsal',
    resolvedHost: PROD, resolvedEndpoint: PROD_ENDPOINT,
    pooledHost: PROD, pooledEndpoint: PROD_ENDPOINT,
    live: null, env: null,
  })
  check('rehearsal mode still refuses production without /api/health',
    rehearsalNoHealthAtProd.some((p) => p.includes('known production fingerprint')))
}

/* ================================= 4. ENVIRONMENT SELF-REPORT ============ */
section('[4] Production mode checks what the app calls itself')
{
  const previewEnv = scenario({
    mode: 'production',
    resolvedHost: PROD, resolvedEndpoint: PROD_ENDPOINT,
    pooledHost: PROD, pooledEndpoint: PROD_ENDPOINT,
    env: 'preview',
  })
  check('production mode refuses an app reporting a non-production environment',
    previewEnv.some((p) => p.includes('not "production"')))

  /**
   * Rehearsal mode deliberately does NOT assert this. The operator is pointed
   * at a copy while the live app keeps reporting "production" — that is the
   * expected state, and asserting on it would only produce noise.
   */
  const rehearsalPreview = scenario({
    mode: 'rehearsal',
    resolvedHost: COPY.direct, resolvedEndpoint: COPY.endpoint,
    pooledHost: COPY.host, pooledEndpoint: COPY.endpoint,
    env: 'production',
  })
  check('rehearsal mode does not object to the live app being production',
    rehearsalPreview.length === 0, rehearsalPreview.join('; '))
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
