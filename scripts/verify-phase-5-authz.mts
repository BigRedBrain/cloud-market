/** MUST BE FIRST — see the header of that module. */
import './_phase-5-test-env.mts'

import { randomUUID } from 'node:crypto'
import { Pool, neonConfig } from '@neondatabase/serverless'

import { decideAdminAccess } from '../lib/auth/admin-decision'


/**
 * Phase 5 authorization decisions — who may administer CloudMarket.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-phase-5-authz.mts
 *
 * WHY THIS SUITE EXISTS SEPARATELY.
 *
 * The unit suite proves the ROUTE ALLOWLIST is right. The database suite proves
 * the SCHEMA cannot represent a third administrator. Neither of them proves the
 * thing in between: that the authorization function, given a user, reaches the
 * correct verdict. That is the single most security-critical decision in this
 * application, and it deserves an exhaustive table rather than a sampled one.
 *
 * `decideAdminAccess` is a pure function precisely so this can be that table.
 * It takes the user, the parsed owner id and the backup-slot occupant, and
 * returns a verdict. Every combination below is enumerated.
 *
 * THE THREE CLAIMS THIS SUITE EXISTS TO PROVE, from sections D, H and AP:
 *
 *   1. A customer cannot reach admin.
 *   2. A customer whose `role` was manually changed to `admin` STILL cannot
 *      reach admin, because their id matches neither the owner variable nor the
 *      backup slot.
 *   3. A customer holding EVERY named permission still cannot reach admin —
 *      demonstrated structurally: permissions are not an input to the decision
 *      at all, and the database half of the claim is verified live below.
 *
 * The database is used only in §F, to confirm that granting every permission row
 * that exists changes nothing. Everything else is pure.
 */

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    failures.push(detail ? `${name} — ${detail}` : name)
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/* -------------------------------------------------------------------------- */

const OWNER_ID = randomUUID()
const BACKUP_ID = randomUUID()
const STRANGER_ID = randomUUID()

const ownerOk = { ok: true as const, ownerId: OWNER_ID }
const ownerMissing = { ok: false as const, reason: 'owner_env_missing' as const }
const ownerMalformed = { ok: false as const, reason: 'owner_env_malformed' as const }

/**
 * Declared locally rather than imported from `lib/auth/session`, which pulls in
 * `server-only` and the database client. The values are asserted against the
 * live `user_role` and `user_status` enums in §G, so a schema change that added
 * a role would fail there rather than silently going untested here.
 */
type Role = 'customer' | 'staff' | 'admin'
type Status = 'active' | 'pending_verification' | 'suspended'

function user(id: string, role: Role, status: Status = 'active') {
  return { id, role, status }
}

const ROLES: Role[] = ['customer', 'staff', 'admin']
const STATUSES: Status[] = ['active', 'pending_verification', 'suspended']

/* ========================================================================== */
section('A. The owner')
/* ========================================================================== */

{
  const verdict = decideAdminAccess({
    user: user(OWNER_ID, 'admin'),
    owner: ownerOk,
    backupUserId: null,
  })
  check('the owner is granted access', verdict.ok)
  check('the owner ranks as owner', verdict.ok && verdict.rank === 'owner')
}

/**
 * THE OWNER IS NOT EXEMPT FROM THE OTHER CONDITIONS. An owner whose account was
 * suspended, or whose role was tampered with, is refused — which is precisely
 * why `setUserStatusAction` and `setUserRoleAction` refuse to touch the owner at
 * all. Without those guards, a backup administrator could lock the owner out
 * permanently by flipping one column.
 */
for (const status of STATUSES.filter((s) => s !== 'active')) {
  const verdict = decideAdminAccess({
    user: user(OWNER_ID, 'admin', status),
    owner: ownerOk,
    backupUserId: null,
  })
  check(`the owner with status="${status}" is refused`, !verdict.ok)
  check(
    `  ...for the right reason`,
    !verdict.ok && verdict.reason === 'account_inactive',
    !verdict.ok ? verdict.reason : '',
  )
}

for (const role of ROLES.filter((r) => r !== 'admin')) {
  const verdict = decideAdminAccess({
    user: user(OWNER_ID, role),
    owner: ownerOk,
    backupUserId: null,
  })
  check(`the owner demoted to "${role}" is refused`, !verdict.ok)
}

/* ========================================================================== */
section('B. The backup administrator')
/* ========================================================================== */

{
  const verdict = decideAdminAccess({
    user: user(BACKUP_ID, 'admin'),
    owner: ownerOk,
    backupUserId: BACKUP_ID,
  })
  check('the slot occupant is granted access', verdict.ok)
  check('the slot occupant ranks as backup', verdict.ok && verdict.rank === 'backup')
  check('the slot occupant is NOT the owner', verdict.ok && verdict.rank !== 'owner')
}

{
  /** Removed from the slot: access ends on the next request. */
  const verdict = decideAdminAccess({
    user: user(BACKUP_ID, 'admin'),
    owner: ownerOk,
    backupUserId: null,
  })
  check('a REMOVED backup is refused immediately', !verdict.ok)
  check(
    '  ...for the right reason',
    !verdict.ok && verdict.reason === 'not_owner_or_backup',
    !verdict.ok ? verdict.reason : '',
  )
}

{
  /** The slot now holds someone else. The previous occupant gets nothing. */
  const verdict = decideAdminAccess({
    user: user(BACKUP_ID, 'admin'),
    owner: ownerOk,
    backupUserId: STRANGER_ID,
  })
  check('a REPLACED backup is refused', !verdict.ok)
}

for (const status of STATUSES.filter((s) => s !== 'active')) {
  const verdict = decideAdminAccess({
    user: user(BACKUP_ID, 'admin', status),
    owner: ownerOk,
    backupUserId: BACKUP_ID,
  })
  check(`the backup with status="${status}" is refused`, !verdict.ok)
}

/* ========================================================================== */
section('C. A customer cannot reach admin')
/* ========================================================================== */

/**
 * The full cross-product. A stranger is refused for every combination of role
 * and status, whether or not a backup slot is occupied by someone else.
 */
for (const role of ROLES) {
  for (const status of STATUSES) {
    for (const slot of [null, BACKUP_ID]) {
      const verdict = decideAdminAccess({
        user: user(STRANGER_ID, role, status),
        owner: ownerOk,
        backupUserId: slot,
      })
      check(
        `stranger role=${role} status=${status} slot=${slot ? 'filled' : 'empty'} is refused`,
        !verdict.ok,
      )
    }
  }
}

/* ========================================================================== */
section('D. role=admin alone is NOT sufficient — the central claim')
/* ========================================================================== */

/**
 * THE ESCALATION THIS MODEL EXISTS TO PREVENT.
 *
 * Someone writes `role = 'admin'` onto their own account — through a future
 * admin screen, a repair script, a migration, or a compromised session that
 * already had some write access. Under the previous `requireRole('admin')`
 * model that was total compromise. Here it is worth nothing.
 */
{
  const verdict = decideAdminAccess({
    user: user(STRANGER_ID, 'admin', 'active'),
    owner: ownerOk,
    backupUserId: null,
  })
  check('a self-promoted role=admin customer is REFUSED', !verdict.ok)
  check(
    '  ...specifically because they are neither owner nor backup',
    !verdict.ok && verdict.reason === 'not_owner_or_backup',
    !verdict.ok ? verdict.reason : '',
  )
}

{
  /** Even with the backup slot legitimately occupied by somebody else. */
  const verdict = decideAdminAccess({
    user: user(STRANGER_ID, 'admin', 'active'),
    owner: ownerOk,
    backupUserId: BACKUP_ID,
  })
  check('a THIRD role=admin account is refused while the slot is filled', !verdict.ok)
}

{
  /**
   * Ten forged administrators at once. All refused: the decision is identity,
   * and there is exactly one owner id and at most one slot occupant, so the
   * number of accounts carrying the role is irrelevant.
   */
  const forged = Array.from({ length: 10 }, () => randomUUID())
  const allRefused = forged.every(
    (id) => !decideAdminAccess({ user: user(id, 'admin'), owner: ownerOk, backupUserId: BACKUP_ID }).ok,
  )
  check('ten simultaneously forged admins are all refused', allRefused)
}

/* ========================================================================== */
section('E. Fail closed on owner misconfiguration')
/* ========================================================================== */

/**
 * A deployment that forgets or fumbles `CLOUDMARKET_OWNER_USER_ID` must deny
 * EVERYONE — including the real owner and a legitimately assigned backup. The
 * alternative, falling back to a role check, would silently downgrade to the
 * weaker model this replaced, and nobody would notice.
 */
for (const [label, owner] of [
  ['missing', ownerMissing],
  ['malformed', ownerMalformed],
] as const) {
  for (const [who, id] of [
    ['the owner', OWNER_ID],
    ['the backup', BACKUP_ID],
    ['a stranger', STRANGER_ID],
  ] as const) {
    const verdict = decideAdminAccess({
      user: user(id, 'admin'),
      owner,
      backupUserId: BACKUP_ID,
    })
    check(`owner env ${label}: ${who} is refused`, !verdict.ok)
    check(
      `  ...reported as owner_env_${label}`,
      !verdict.ok && verdict.reason === `owner_env_${label}`,
      !verdict.ok ? verdict.reason : '',
    )
  }
}

/**
 * An owner id that is well-formed but WRONG — pointing at no account, or at the
 * wrong one — denies the real owner. Correct: the environment is authoritative,
 * so a mistake in it is a lockout, not a bypass. Runbook §8 covers recovery.
 */
{
  const verdict = decideAdminAccess({
    user: user(OWNER_ID, 'admin'),
    owner: { ok: true, ownerId: randomUUID() },
    backupUserId: null,
  })
  check('an owner env pointing at the WRONG id denies the real owner', !verdict.ok)
}

/* ========================================================================== */
section('F. Named permissions can never confer admin access')
/* ========================================================================== */

/**
 * STRUCTURAL PROOF FIRST. `decideAdminAccess` has no parameter for permissions.
 * They are not an input, so they cannot be an influence — which is a stronger
 * statement than "we check them and then ignore them", and it is enforced by
 * the type system rather than by a test.
 *
 * The live half below confirms the other side of the claim: that granting every
 * permission the enum defines really does leave a customer with nothing.
 */
{
  const before = decideAdminAccess({
    user: user(STRANGER_ID, 'customer'),
    owner: ownerOk,
    backupUserId: null,
  })
  check('a customer is refused (baseline)', !before.ok)
}

const pooled = process.env.DATABASE_URL
if (!pooled) {
  console.log('  (skipped live check: DATABASE_URL not set)')
} else {
  const { hostFp, KNOWN_FINGERPRINTS } = await import('./verify-migration-target.mjs')
  if (hostFp(pooled) === KNOWN_FINGERPRINTS.productionHost) {
    console.error('REFUSING: target is production.')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: pooled })
  const tag = `authztest_${randomUUID().slice(0, 8)}`

  try {
    const { rows: created } = await pool.query(
      `insert into users (email, name, role, status, email_verified_at)
       values ($1, $2, 'customer', 'active', now()) returning id`,
      [`${tag}@example.invalid`, `${tag}`],
    )
    const victimId = created[0].id as string

    /** Every value the enum defines — read from the database, not hard-coded. */
    const { rows: perms } = await pool.query(
      `select unnest(enum_range(null::admin_permission))::text as p`,
    )
    check('the permission enum has values to grant', perms.length > 0, `${perms.length}`)

    for (const { p } of perms) {
      await pool.query(
        `insert into user_permissions (user_id, permission) values ($1, $2)`,
        [victimId, p],
      )
    }

    const { rows: granted } = await pool.query(
      `select count(*)::int n from user_permissions
       where user_id = $1 and revoked_at is null`,
      [victimId],
    )
    check(
      'the customer now holds EVERY named permission',
      granted[0].n === perms.length,
      `${granted[0].n}/${perms.length}`,
    )

    /** Their role and identity are unchanged, which is the whole point. */
    const { rows: state } = await pool.query(
      `select role, status from users where id = $1`,
      [victimId],
    )

    const verdict = decideAdminAccess({
      user: { id: victimId, role: state[0].role, status: state[0].status },
      owner: ownerOk,
      backupUserId: BACKUP_ID,
    })

    check('a customer with EVERY permission is STILL refused admin access', !verdict.ok)
    check(
      '  ...refused on role, before identity is even reached',
      !verdict.ok && verdict.reason === 'role_not_admin',
      !verdict.ok ? verdict.reason : '',
    )

    /**
     * And the compound case: every permission AND a forged `role = 'admin'`.
     * This is the worst realistic insider scenario, and it still yields nothing.
     */
    await pool.query(`update users set role = 'admin' where id = $1`, [victimId]).catch(() => {
      /** The two-admin trigger may refuse; the decision below is what matters. */
    })

    const compound = decideAdminAccess({
      user: { id: victimId, role: 'admin', status: 'active' },
      owner: ownerOk,
      backupUserId: BACKUP_ID,
    })
    check(
      'every permission PLUS a forged role=admin is STILL refused',
      !compound.ok,
    )
    check(
      '  ...refused because they are neither owner nor backup',
      !compound.ok && compound.reason === 'not_owner_or_backup',
      !compound.ok ? compound.reason : '',
    )

    /* ====================================================================== */
    section('G. The tested cross-product covers the real enums')
    /* ====================================================================== */

    /**
     * The cross-product in §C is only exhaustive if `ROLES` and `STATUSES`
     * actually list every value the database can hold. Adding a fourth role
     * without extending this suite would leave a live authorization path
     * untested while every assertion still passed — so the lists are checked
     * against the enums themselves.
     */
    const { rows: dbRoles } = await pool.query(
      `select unnest(enum_range(null::user_role))::text as v`,
    )
    const { rows: dbStatuses } = await pool.query(
      `select unnest(enum_range(null::user_status))::text as v`,
    )

    const roleSet = dbRoles.map((r) => r.v as string).sort()
    const statusSet = dbStatuses.map((r) => r.v as string).sort()

    check(
      'every user_role value is covered by the cross-product',
      JSON.stringify(roleSet) === JSON.stringify([...ROLES].sort()),
      `db=${roleSet.join(',')} tested=${[...ROLES].sort().join(',')}`,
    )
    check(
      'every user_status value is covered by the cross-product',
      JSON.stringify(statusSet) === JSON.stringify([...STATUSES].sort()),
      `db=${statusSet.join(',')} tested=${[...STATUSES].sort().join(',')}`,
    )
  } finally {
    await pool.query(
      `delete from user_permissions where user_id in (select id from users where email like $1)`,
      [`${tag}%`],
    )
    await pool.query(`delete from audit_log where user_id in (select id from users where email like $1)`, [`${tag}%`])
    await pool.query(`delete from users where email like $1`, [`${tag}%`])
    await pool.end()
  }
}

/* ========================================================================== */

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m (${passed + failed} checks)\n`)

if (failed > 0) {
  for (const failure of failures) console.error(`  \x1b[31m✗\x1b[0m ${failure}`)
  process.exit(1)
}
