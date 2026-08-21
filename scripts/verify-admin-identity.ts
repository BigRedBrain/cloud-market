/**
 * Administrator identity primitives — deterministic checks.
 *
 * Run: npm run test:admin-identity
 *
 * HERMETIC BY CONSTRUCTION. No `.env.local`, no database, no network. Every
 * value is a throwaway fixture, assigned with `=` rather than `??=` so an
 * ambient `CLOUDMARKET_OWNER_USER_ID` in a developer's shell cannot silently
 * become the thing under test. The database URL never opens a connection:
 * `lib/auth/admin-identity.ts` imports `serverEnv` and two erased types, never
 * `lib/db`. `--conditions=react-server` resolves its `server-only` import to
 * the empty module, exactly as the Next build does.
 *
 * WHY THREE PROCESSES. `serverEnv()` memoises on first call
 * (`cachedServerEnv ??= parseServer()`), so the owner variable cannot be
 * changed once anything has read it. The three owner-configuration states —
 * present, absent, malformed — therefore each need their own process. The
 * parent runs the "configured" set in-process and re-execs itself for the other
 * two. Faking the env read instead would test a mock rather than the function
 * that actually gates production.
 *
 * WHAT THIS IS PROVING. Not that the code runs, but claims that are invisible
 * from reading it:
 *
 *   1. `users.role` is not a path to administrator. A user carrying
 *      `role: 'admin'` who is neither owner nor backup is DENIED.
 *   2. Owner precedence is structural, not a comparison made afterwards — when
 *      the owner signs in, the backup slot is never queried at all.
 *   3. A BROKEN OWNER VARIABLE DOES NOT LOCK OUT THE BACKUP. This is the
 *      regression this file now exists for: an earlier draft returned as soon
 *      as the owner variable failed to parse, so a single typo would have left
 *      the platform with no reachable administrator and no in-product fix.
 *   4. Letter case in the configured owner id cannot cause a lockout, because
 *      Postgres renders `uuid` lower-case and RFC 4122 permits `A-F`.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SessionUser } from '../lib/auth/session'

type Scenario = 'configured' | 'owner_not_configured' | 'owner_malformed'

const SCENARIO = (process.env.CLOUDMARKET_TEST_SCENARIO ?? 'configured') as Scenario

/* Lower case, as a `uuid` column always renders them. */
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const BACKUP_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_ID = '33333333-3333-4333-8333-333333333333'

process.env.AUTH_SECRET = 'verify-admin-identity-fixture-auth-secret-0000'
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture'
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'

if (SCENARIO === 'configured') {
  /*
   * UPPERCASE and PADDED, deliberately, so every owner assertion below is also
   * a canonicalisation assertion. Both hazards are things a real operator does:
   * ids get pasted out of spreadsheets with a trailing newline, and get typed
   * or transcribed in caps. Either one silently matching nobody would present
   * as "I set the variable correctly and I still can't get in".
   */
  process.env.CLOUDMARKET_OWNER_USER_ID = `  ${OWNER_ID.toUpperCase()}\n`
} else if (SCENARIO === 'owner_malformed') {
  process.env.CLOUDMARKET_OWNER_USER_ID = 'owner@cloudmarket.example'
} else {
  delete process.env.CLOUDMARKET_OWNER_USER_ID
}

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const pass = Object.is(actual, expected)
  if (!pass) failures += 1
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass
        ? ''
        : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  )
}

function assert(name: string, condition: boolean, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `\n        ${detail}`}`)
}

/** A session user. `role` is set explicitly because it must never matter. */
function userFixture(id: string, role: SessionUser['role'] = 'customer'): SessionUser {
  return {
    id,
    email: `${id}@fixture.invalid`,
    name: null,
    role,
    status: 'active',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

/** Source text with comments removed, so ordering checks read code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** A top-level `export async function` declaration, up to its closing brace. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`)
  if (start === -1) return ''
  const end = source.indexOf('\n}', start)
  return end === -1 ? source.slice(start) : source.slice(start, end + 2)
}

/** A backup lookup that records whether it was called. */
function trackedLookup(result: string | null) {
  let calls = 0
  return {
    fn: async () => {
      calls += 1
      return result
    },
    calls: () => calls,
  }
}

async function main() {
  const {
    auditEventForFailure,
    auditEventForOwnerConfig,
    isUuid,
    readConfiguredOwnerId,
    resolveAdminIdentity,
  } = await import('../lib/auth/admin-identity')

  console.log(`\n########  scenario: ${SCENARIO}  ########`)

  if (SCENARIO === 'configured') {
    console.log('\n-- isUuid ------------------------------------------------')

    check('canonical v4 accepted', isUuid(OWNER_ID), true)
    check('upper case accepted', isUuid(OWNER_ID.toUpperCase()), true)
    check(
      'non-v4 layout still accepted (shape check, not version check)',
      isUuid('11111111-1111-1111-1111-111111111111'),
      true,
    )
    check('empty rejected', isUuid(''), false)
    check('email rejected', isUuid('owner@cloudmarket.example'), false)
    check('dashes stripped rejected', isUuid(OWNER_ID.replace(/-/g, '')), false)
    check('truncated rejected', isUuid(OWNER_ID.slice(0, 35)), false)
    check('trailing character rejected', isUuid(`${OWNER_ID}0`), false)
    check('untrimmed rejected', isUuid(` ${OWNER_ID}`), false)
    check('placeholder text rejected', isUuid('replace-me'), false)

    console.log('\n-- readConfiguredOwnerId ---------------------------------')

    const owner = readConfiguredOwnerId()
    assert('owner id resolves when configured', owner.ok)
    check(
      'UPPERCASE configured value is canonicalised to lower case',
      owner.ok ? owner.userId : null,
      OWNER_ID,
    )
    check(
      'and surrounding whitespace is trimmed off',
      owner.ok ? owner.userId.length : null,
      OWNER_ID.length,
    )

    console.log('\n-- resolveAdminIdentity ----------------------------------')

    {
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(null, lookup.fn)
      check('anonymous is unauthorized', r.status, 'unauthorized')
      check(
        'anonymous reason is not_signed_in',
        r.status === 'unauthorized' ? r.detail : null,
        'not_signed_in',
      )
      check(
        'anonymous carries no user for attribution',
        r.status === 'unauthorized' ? r.user : undefined,
        null,
      )
      check('anonymous does not query the backup slot', lookup.calls(), 0)
    }

    {
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(OWNER_ID), lookup.fn)
      check('configured owner is authorized', r.status, 'authorized')
      check(
        'UPPERCASE configured owner matches lower-case SessionUser.id',
        r.status === 'authorized' ? r.identity.kind : null,
        'owner',
      )
      check(
        'authorized result carries the session user',
        r.status === 'authorized' ? r.identity.user.id : null,
        OWNER_ID,
      )
      check(
        'authorized result reports owner configuration healthy',
        r.status === 'authorized' ? r.ownerConfig : null,
        'ok',
      )
      assert(
        'OWNER SHORT-CIRCUITS — the backup slot is never queried',
        lookup.calls() === 0,
        `lookup was called ${lookup.calls()} time(s)`,
      )
    }

    {
      // Owner and backup are the same account. Owner must win, and must win
      // without the query — precedence is structural, not a tie-break.
      const lookup = trackedLookup(OWNER_ID)
      const r = await resolveAdminIdentity(userFixture(OWNER_ID), lookup.fn)
      check(
        'owner outranks backup when they are the same user',
        r.status === 'authorized' ? r.identity.kind : null,
        'owner',
      )
      check('and still without querying', lookup.calls(), 0)
    }

    {
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(BACKUP_ID), lookup.fn)
      check('live backup is authorized', r.status, 'authorized')
      check(
        'live backup is kind backup',
        r.status === 'authorized' ? r.identity.kind : null,
        'backup',
      )
      check('backup path queries the slot exactly once', lookup.calls(), 1)
    }

    {
      // Defensive: the slot is a `uuid` column so this cannot happen today,
      // but a case-sensitive compare here would be a silent lockout if it ever
      // came back through a text path.
      const lookup = trackedLookup(BACKUP_ID.toUpperCase())
      const r = await resolveAdminIdentity(userFixture(BACKUP_ID), lookup.fn)
      check(
        'backup match is case-insensitive too',
        r.status === 'authorized' ? r.identity.kind : null,
        'backup',
      )
    }

    {
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(STRANGER_ID), lookup.fn)
      check('unrelated user is unauthorized', r.status, 'unauthorized')
      check(
        'unrelated user reason is not_an_administrator',
        r.status === 'unauthorized' ? r.detail : null,
        'not_an_administrator',
      )
      check(
        'unrelated user is reported with owner configuration healthy',
        r.status === 'unauthorized' ? r.ownerConfig : null,
        'ok',
      )
      check(
        'unrelated user is carried for audit attribution',
        r.status === 'unauthorized' ? r.user?.id : null,
        STRANGER_ID,
      )
    }

    {
      /*
       * THE LOAD-BEARING ASSERTION. This account is `role: 'admin'` — exactly
       * what `requireAdmin()` accepts today and exactly what the cutover stops
       * accepting. If a `users.role` fallback is ever added "so nobody gets
       * locked out", this is the check that fails.
       */
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(STRANGER_ID, 'admin'), lookup.fn)
      check(
        'users.role = admin is NOT a path to administrator',
        r.status,
        'unauthorized',
      )
      check(
        'and is refused as not_an_administrator, not as a config error',
        r.status === 'unauthorized' ? r.detail : null,
        'not_an_administrator',
      )
    }

    {
      const lookup = trackedLookup(null)
      const r = await resolveAdminIdentity(userFixture(BACKUP_ID), lookup.fn)
      check(
        'an empty backup slot authorizes nobody',
        r.status,
        'unauthorized',
      )
      check(
        'even for the user who previously held it',
        r.status === 'unauthorized' ? r.detail : null,
        'not_an_administrator',
      )
    }

    console.log('\n-- audit mapping -----------------------------------------')

    check(
      'missing owner config is a configuration incident',
      auditEventForFailure('owner_not_configured'),
      'OWNER_IDENTITY_MISCONFIGURED',
    )
    check(
      'malformed owner config is the same incident',
      auditEventForFailure('owner_malformed'),
      'OWNER_IDENTITY_MISCONFIGURED',
    )
    check(
      'an unauthorized signed-in user is an access denial',
      auditEventForFailure('not_an_administrator'),
      'ADMIN_ACCESS_DENIED',
    )
    check(
      'an anonymous request is neither and records nothing',
      auditEventForFailure('not_signed_in'),
      null,
    )
    check(
      'healthy owner config records nothing',
      auditEventForOwnerConfig('ok'),
      null,
    )
    check(
      'a fault on an AUTHORIZED resolution still reports the incident',
      auditEventForOwnerConfig('owner_malformed'),
      'OWNER_IDENTITY_MISCONFIGURED',
    )

    console.log('\n-- authentication boundary (SOURCE STRUCTURE) ------------')

    /*
     * READ THIS BEFORE TRUSTING THE SECTION BELOW.
     *
     * These are assertions about the SHAPE OF THE SOURCE, not about behaviour.
     * They cannot observe a redirect. `requireAdminIdentity()` needs a database
     * and a request scope, and this harness deliberately has neither, so the
     * behavioural proof that an anonymous request reaches sign-in rather than a
     * 403 lives in the e2e suites (`scripts/verify-auth-e2e.mjs` asserts on
     * content denial for exactly this class of guard) and cannot be produced
     * here.
     *
     * What they DO pin is the property a reviewer would otherwise have to
     * re-derive by reading two files: that authentication happens before
     * authorization, and that the silent probe stays silent. The bug these
     * exist for was invisible in isolation — `requireAdminIdentity()` looked
     * correct on its own, and was only wrong relative to the boundary
     * `requireAdmin()` establishes several calls away.
     */

    const dalSource = readFileSync(
      join(__dirname, '..', 'lib', 'auth', 'dal.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n')

    const requireBody = extractFunction(dalSource, 'requireAdminIdentity')
    const probeBody = extractFunction(dalSource, 'getAdminIdentity')
    const requireCode = stripComments(requireBody)
    const probeCode = stripComments(probeBody)

    assert(
      'requireAdminIdentity() was found in the DAL',
      requireBody.length > 0,
      'extraction failed — the rest of this section is meaningless',
    )
    assert(
      'getAdminIdentity() was found in the DAL',
      probeBody.length > 0,
      'extraction failed — the rest of this section is meaningless',
    )

    assert(
      'requireAdminIdentity() requires authentication first',
      requireCode.includes('requireUser()'),
      'anonymous callers would get forbidden() instead of a sign-in redirect',
    )
    /*
     * Both indices are checked for presence before being compared. A bare
     * `indexOf(a) < indexOf(b)` reports success when `a` is missing entirely,
     * because -1 is less than everything — an ordering assertion that passes
     * precisely when the thing it orders has been deleted.
     */
    const authAt = requireCode.indexOf('requireUser()')
    const resolveAt = requireCode.indexOf('resolveAdminIdentityCached()')
    assert(
      'and does so BEFORE resolving authorization',
      authAt >= 0 && resolveAt >= 0 && authAt < resolveAt,
      `requireUser() at ${authAt}, resolution at ${resolveAt}; ` +
        'resolving first would reach the ADMIN_ACCESS_DENIED path for anonymous users',
    )
    assert(
      'it uses requireUser(), not requireVerifiedUser()',
      !requireCode.includes('requireVerifiedUser'),
      'requireRole() does not gate on email verification, so neither may this',
    )
    assert(
      'requireAdminIdentity() is NOT cache()-wrapped',
      !dalSource.includes('requireAdminIdentity = cache('),
      'it throws navigation interrupts; memoising those is the documented DAL rule',
    )

    assert(
      'getAdminIdentity() stays a silent nullable probe — no requireUser()',
      !probeCode.includes('requireUser'),
      'the probe must return null for anonymous, never redirect',
    )
    assert(
      'getAdminIdentity() writes no audit events',
      !probeCode.includes('recordAuditEvent'),
      'a probe runs on ordinary renders; auditing it would bury real incidents',
    )
    assert(
      'getAdminIdentity() never calls forbidden()',
      !probeCode.includes('forbidden('),
      'it is a rendering aid, not an authorization boundary',
    )

    const resolverSource = readFileSync(
      join(__dirname, '..', 'lib', 'auth', 'admin-identity.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    const resolverCode = stripComments(resolverSource)

    assert(
      'the shared resolver stays side-effect free',
      !resolverCode.includes('recordAuditEvent') &&
        !resolverCode.includes('forbidden(') &&
        !resolverCode.includes('redirect('),
      'both entry points share it; a side effect there fires on silent probes too',
    )
    assert(
      'and never reads users.role',
      !/\buser\.role\b/.test(resolverCode),
      'role is not a path to administrator',
    )
  } else {
    /*
     * THE REGRESSION SCENARIOS.
     *
     * A broken owner variable must disable OWNER authorization and nothing
     * else. The backup slot is a database row; an environment variable cannot
     * invalidate it, and treating it as though it could turns one typo into a
     * platform with no reachable administrator.
     */
    const expectedFault =
      SCENARIO === 'owner_malformed' ? 'owner_malformed' : 'owner_not_configured'

    const owner = readConfiguredOwnerId()
    check('owner id does not resolve', owner.ok, false)
    check(
      'and reports the specific fault',
      owner.ok ? null : owner.reason,
      expectedFault,
    )

    {
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(BACKUP_ID), lookup.fn)
      assert(
        'THE BACKUP ADMINISTRATOR IS STILL AUTHORIZED',
        r.status === 'authorized',
        'a broken owner variable must not lock out the backup slot',
      )
      check(
        'and is authorized as backup',
        r.status === 'authorized' ? r.identity.kind : null,
        'backup',
      )
      check(
        'the backup slot IS queried despite the broken owner variable',
        lookup.calls(),
        1,
      )
      check(
        'the resolution preserves the owner fault for the guard to audit',
        r.status === 'authorized' ? r.ownerConfig : null,
        expectedFault,
      )
      check(
        'so the guard can record OWNER_IDENTITY_MISCONFIGURED on a SUCCESS',
        r.status === 'authorized' ? auditEventForOwnerConfig(r.ownerConfig) : null,
        'OWNER_IDENTITY_MISCONFIGURED',
      )
    }

    {
      // The user named by the broken variable is not thereby an administrator.
      // `role: 'admin'` is set to prove it is not consulted as a rescue path.
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(userFixture(OWNER_ID, 'admin'), lookup.fn)
      check('a non-backup user is unauthorized', r.status, 'unauthorized')
      check(
        'reason names the configuration fault',
        r.status === 'unauthorized' ? r.detail : null,
        expectedFault,
      )
      check(
        'ownerConfig reports the fault',
        r.status === 'unauthorized' ? r.ownerConfig : null,
        expectedFault,
      )
      check(
        'the backup slot was still consulted before denying',
        lookup.calls(),
        1,
      )
      check(
        'the failure maps to OWNER_IDENTITY_MISCONFIGURED',
        r.status === 'unauthorized' ? auditEventForFailure(r.detail) : null,
        'OWNER_IDENTITY_MISCONFIGURED',
      )
    }

    {
      const lookup = trackedLookup(null)
      const r = await resolveAdminIdentity(userFixture(BACKUP_ID, 'admin'), lookup.fn)
      check(
        'broken owner variable AND empty slot authorizes nobody',
        r.status,
        'unauthorized',
      )
      check(
        'and still does not fall back to users.role',
        r.status === 'unauthorized' ? r.detail : null,
        expectedFault,
      )
    }

    {
      // The owner variable is read before the session check, but the anonymous
      // branch is the first to DECIDE: the detail comes back `not_signed_in`
      // whatever the fault is, so a drive-by cannot make the log claim a
      // misconfiguration was discovered. The fault still travels on
      // `ownerConfig`, which the last assertion in this block covers.
      const lookup = trackedLookup(BACKUP_ID)
      const r = await resolveAdminIdentity(null, lookup.fn)
      check(
        'anonymous is still reported as not_signed_in, not as a config error',
        r.status === 'unauthorized' ? r.detail : null,
        'not_signed_in',
      )
      check(
        'and records nothing',
        r.status === 'unauthorized' ? auditEventForFailure(r.detail) : 'unused',
        null,
      )
      check('and does not query the backup slot', lookup.calls(), 0)
      check(
        'while still reporting the fault for a configuration health check',
        r.status === 'unauthorized' ? r.ownerConfig : null,
        expectedFault,
      )
    }
  }

  /* The parent runs the two broken-configuration scenarios as child processes. */
  if (SCENARIO === 'configured') {
    for (const scenario of ['owner_not_configured', 'owner_malformed'] as const) {
      const result = spawnSync(
        process.execPath,
        ['--conditions=react-server', '--import', 'tsx', __filename],
        {
          stdio: 'inherit',
          env: { ...process.env, CLOUDMARKET_TEST_SCENARIO: scenario },
        },
      )
      if (result.status !== 0) failures += 1
    }
  }

  console.log(
    `\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s) [${SCENARIO}]\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
