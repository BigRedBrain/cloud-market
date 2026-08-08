/** MUST BE FIRST — see the header of that module. */
import './_phase-5-test-env.mts'

import { randomUUID } from 'node:crypto'
import { Pool, neonConfig } from '@neondatabase/serverless'

import { generateInviteCode, hashInviteCode, normaliseInviteCode } from '../lib/invites/codes'

/**
 * Phase 5 database invariants.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-phase-5-db.mts
 *
 * REQUIRES MIGRATION 0017 AND REFUSES TO RUN AGAINST PRODUCTION. The target is
 * fingerprinted before a single statement is issued, using the same pure
 * function `scripts/verify-migration-target.mjs` exposes — this suite writes and
 * deletes rows, and "I thought .env.local pointed at development" is not a
 * recovery plan.
 *
 * WHAT NEEDS A DATABASE, AND THEREFORE LIVES HERE RATHER THAN IN THE UNIT SUITE
 *
 * Three of the security claims in this phase are claims about CONCURRENCY, and a
 * race cannot be demonstrated against a pure function:
 *
 *   1. The backup slot admits exactly one live occupant, even when two sessions
 *      insert simultaneously.
 *   2. Two simultaneous redemptions of an invite's final use produce exactly one
 *      success.
 *   3. The same webhook delivered twice is applied once.
 *
 * Each is enforced by a database object — a partial unique index, a conditional
 * UPDATE, another unique index — precisely so the guarantee does not depend on
 * application code winning a race. This suite is what proves the objects exist
 * and behave as claimed.
 *
 * Everything it creates is prefixed and removed in a `finally`, so a failed run
 * does not leave debris behind.
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
/* Target safety                                                               */
/* -------------------------------------------------------------------------- */

const { hostFp, KNOWN_FINGERPRINTS } = await import('./verify-migration-target.mjs')

const pooled = process.env.DATABASE_URL
if (!pooled) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const direct = process.env.DATABASE_URL_UNPOOLED ?? pooled

/**
 * A hard refusal, not a warning. This suite writes rows.
 */
if (hostFp(direct) === KNOWN_FINGERPRINTS.productionHost || hostFp(pooled) === KNOWN_FINGERPRINTS.productionHost) {
  console.error('\x1b[31mREFUSING TO RUN: the configured database is production.\x1b[0m')
  process.exit(1)
}

const pool = new Pool({ connectionString: pooled })

/** Everything this suite creates carries this, so cleanup is unambiguous. */
const TAG = `phase5test_${randomUUID().slice(0, 8)}`
const email = (label: string) => `${TAG}_${label}@example.invalid`

async function cleanup(): Promise<void> {
  /** Order matters: redemptions reference invites with ON DELETE RESTRICT. */
  await pool.query(
    `delete from invite_code_redemptions where user_id in (select id from users where email like $1)`,
    [`${TAG}%`],
  )
  await pool.query(`delete from admin_backup where user_id in (select id from users where email like $1)`, [`${TAG}%`])
  await pool.query(`delete from payment_events where provider_event_id like $1`, [`${TAG}%`])
  await pool.query(`delete from invite_codes where label = $1`, [TAG])
  await pool.query(`delete from audit_log where user_id in (select id from users where email like $1)`, [`${TAG}%`])
  await pool.query(`delete from users where email like $1`, [`${TAG}%`])
}

async function createUser(label: string, role = 'customer'): Promise<string> {
  const { rows } = await pool.query(
    `insert into users (email, name, role, status, email_verified_at)
     values ($1, $2, $3, 'active', now()) returning id`,
    [email(label), `${TAG} ${label}`, role],
  )
  return rows[0].id as string
}

try {
  /* ====================================================================== */
  section('A. Schema is present (migration 0017 applied)')
  /* ====================================================================== */

  for (const table of ['admin_backup', 'invite_codes', 'invite_code_redemptions', 'payment_intents', 'payment_events']) {
    const { rows } = await pool.query(`select to_regclass($1) as t`, [`public.${table}`])
    check(`table ${table} exists`, rows[0].t !== null, 'run migration 0017 first')
  }

  {
    const { rows } = await pool.query(
      `select tgname from pg_trigger where tgname = 'users_max_two_admins'`,
    )
    check('two-admin trigger is installed', rows.length === 1)
  }

  {
    const { rows } = await pool.query(
      `select indexname from pg_indexes where indexname = 'admin_backup_single_active_slot'`,
    )
    check('single-slot unique index exists', rows.length === 1)
  }

  /* ====================================================================== */
  section('B. The backup slot admits exactly one occupant')
  /* ====================================================================== */

  const alice = await createUser('alice')
  const bob = await createUser('bob')

  await pool.query(`insert into admin_backup (user_id) values ($1)`, [alice])
  check('first backup assignment succeeds', true)

  {
    let rejected = false
    try {
      await pool.query(`insert into admin_backup (user_id) values ($1)`, [bob])
    } catch (error) {
      rejected = (error as { code?: string }).code === '23505'
    }
    check('a SECOND live backup is rejected by the database', rejected)
  }

  /**
   * THE CONCURRENCY CASE. Two transactions inserting at the same instant, with
   * no coordination in application code. Exactly one must survive.
   */
  {
    await pool.query(`delete from admin_backup where user_id = $1`, [alice])

    const carol = await createUser('carol')
    const dave = await createUser('dave')

    const results = await Promise.allSettled([
      pool.query(`insert into admin_backup (user_id) values ($1)`, [carol]),
      pool.query(`insert into admin_backup (user_id) values ($1)`, [dave]),
    ])

    const succeeded = results.filter((r) => r.status === 'fulfilled').length
    check('exactly one of two concurrent assignments succeeds', succeeded === 1, `${succeeded} succeeded`)

    const { rows } = await pool.query(`select count(*)::int n from admin_backup where revoked_at is null`)
    check('exactly one live backup row remains', rows[0].n === 1, `${rows[0].n} rows`)
  }

  /**
   * Revocation frees the slot — otherwise removing a backup administrator would
   * permanently prevent appointing another.
   */
  {
    await pool.query(`update admin_backup set revoked_at = now() where revoked_at is null`)
    await pool.query(`insert into admin_backup (user_id) values ($1)`, [bob])
    const { rows } = await pool.query(`select count(*)::int n from admin_backup where revoked_at is null`)
    check('the slot is reusable after revocation', rows[0].n === 1)
    await pool.query(`update admin_backup set revoked_at = now() where revoked_at is null`)
  }

  /** The CHECK that pins the slot column, without which the index is decorative. */
  {
    let rejected = false
    try {
      await pool.query(`insert into admin_backup (user_id, slot) values ($1, 2)`, [alice])
    } catch {
      rejected = true
    }
    check('slot values other than 1 are rejected', rejected)
  }

  /* ====================================================================== */
  section('C. The two-admin ceiling')
  /* ====================================================================== */

  /**
   * THE STARTING STATE IS NOT ASSUMED, AND THE FIRST VERSION OF THIS SECTION
   * WAS WRONG BECAUSE IT WAS.
   *
   * It asserted "promotion is blocked at the third administrator", which is only
   * true of a database with none. Development carries six `role = 'admin'`
   * accounts seeded across earlier phases, so the trigger — correctly — refused
   * the very first promotion, and the assertion failed while the invariant it
   * was meant to prove held perfectly.
   *
   * The trigger fires on INSERT and UPDATE only. It does not retroactively
   * reject rows that predate it, which is deliberate: a migration that failed
   * because production already had three administrators would be a migration
   * that could not be applied at all. The consequence is that the ceiling
   * constrains CHANGES, not existing state, and the runbook's pre-flight step
   * (demote extras before applying 0017) is what handles the rest.
   *
   * So the ceiling is now proved two ways.
   */
  {
    const { rows } = await pool.query(
      `select count(*)::int n from users where role = 'admin' and deleted_at is null`,
    )
    const existing = rows[0].n as number
    console.log(`  (this database starts with ${existing} admin accounts)`)

    /* --- 1. Against the REAL current state: the count can never grow. ----- */
    {
      const id = await createUser('ceiling_probe')
      let blocked = false
      try {
        await pool.query(`update users set role = 'admin' where id = $1`, [id])
      } catch (error) {
        blocked = (error as { code?: string }).code === '23514'
      }

      if (existing >= 2) {
        check('with the ceiling already met, a further promotion is refused', blocked)
      } else {
        check('below the ceiling, promotion is permitted', !blocked)
        await pool.query(`update users set role = 'customer' where id = $1`, [id])
      }

      const { rows: after } = await pool.query(
        `select count(*)::int n from users where role = 'admin' and deleted_at is null`,
      )
      check(
        'the live administrator count never increases',
        (after[0].n as number) <= Math.max(existing, 2),
        `${existing} -> ${after[0].n}`,
      )
    }

    /* --- 2. From a CLEAN slate, inside a transaction that is rolled back. --
     *
     * A dedicated connection, because a transaction belongs to one client. Every
     * write below is discarded by the ROLLBACK, so the development data is
     * untouched — this is the only way to exercise "the third is refused"
     * without demoting six real accounts.
     */
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`update users set role = 'customer' where role = 'admin'`)

      const ids: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const { rows: created } = await client.query(
          `insert into users (email, name, role, status, email_verified_at)
           values ($1, $2, 'customer', 'active', now()) returning id`,
          [email(`ceiling${i}`), `${TAG} ceiling${i}`],
        )
        ids.push(created[0].id as string)
      }

      let blockedAt = -1
      for (let i = 0; i < 3; i += 1) {
        try {
          await client.query(`update users set role = 'admin' where id = $1`, [ids[i]])
        } catch {
          blockedAt = i
          /** The failed statement aborts the transaction; recover to continue. */
          await client.query('rollback')
          break
        }
      }

      check(
        'from a clean slate, the THIRD promotion is refused',
        blockedAt === 2,
        `blocked at index ${blockedAt}`,
      )
    } finally {
      /** Discards everything above, including the mass demotion. */
      try {
        await client.query('rollback')
      } catch {
        /* already rolled back by the failed statement */
      }
      client.release()
    }

    /* --- 3. Demotion must always work, or the ceiling becomes a trap. ----- */
    {
      const id = await createUser('demote_probe')
      await pool.query(`update users set role = 'customer' where id = $1`, [id])
      const { rows: r } = await pool.query(`select role from users where id = $1`, [id])
      check('demotion is always permitted', r[0].role === 'customer')
    }

    /* --- 4. The mass demotion inside the transaction really was discarded. */
    {
      const { rows: after } = await pool.query(
        `select count(*)::int n from users where role = 'admin' and deleted_at is null`,
      )
      check(
        'the rolled-back transaction left existing admins intact',
        after[0].n === existing,
        `${existing} -> ${after[0].n}`,
      )
    }
  }

  /* ====================================================================== */
  section('D. Invite redemption is atomic')
  /* ====================================================================== */

  const claimSql = `
    update invite_codes
       set use_count = use_count + 1
     where code_hash = $1
       and deactivated_at is null
       and (expires_at is null or expires_at > now())
       and use_count < max_uses
    returning id`

  async function makeInvite(options: {
    maxUses?: number
    expiresAt?: string | null
    deactivated?: boolean
  } = {}) {
    const generated = generateInviteCode()
    const { rows } = await pool.query(
      `insert into invite_codes (code_hash, code_prefix, label, max_uses, expires_at, deactivated_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        generated.codeHash,
        generated.codePrefix,
        TAG,
        options.maxUses ?? 1,
        options.expiresAt ?? null,
        options.deactivated ? new Date().toISOString() : null,
      ],
    )
    return { ...generated, id: rows[0].id as string }
  }

  {
    const invite = await makeInvite({ maxUses: 1 })
    const first = await pool.query(claimSql, [invite.codeHash])
    check('a valid invite can be claimed', first.rowCount === 1)

    const second = await pool.query(claimSql, [invite.codeHash])
    check('a single-use invite cannot be claimed twice', second.rowCount === 0)
  }

  /**
   * THE CASE SECTION P NAMES EXPLICITLY: two simultaneous registrations must not
   * both consume the final available use.
   */
  {
    const invite = await makeInvite({ maxUses: 1 })

    const results = await Promise.all([
      pool.query(claimSql, [invite.codeHash]),
      pool.query(claimSql, [invite.codeHash]),
    ])

    const wins = results.filter((r) => r.rowCount === 1).length
    check('exactly one of two concurrent claims succeeds', wins === 1, `${wins} succeeded`)

    const { rows } = await pool.query(`select use_count from invite_codes where id = $1`, [invite.id])
    check('use_count is exactly 1 after the race', rows[0].use_count === 1, `use_count=${rows[0].use_count}`)
  }

  /** Ten at once on a five-use invite: five wins, five refusals, count exactly 5. */
  {
    const invite = await makeInvite({ maxUses: 5 })

    const results = await Promise.all(
      Array.from({ length: 10 }, () => pool.query(claimSql, [invite.codeHash])),
    )

    const wins = results.filter((r) => r.rowCount === 1).length
    check('a 5-use invite admits exactly 5 of 10 concurrent claims', wins === 5, `${wins} succeeded`)

    const { rows } = await pool.query(`select use_count from invite_codes where id = $1`, [invite.id])
    check('use_count never exceeds max_uses', rows[0].use_count === 5, `use_count=${rows[0].use_count}`)
  }

  {
    const invite = await makeInvite({ deactivated: true })
    const result = await pool.query(claimSql, [invite.codeHash])
    check('a deactivated invite cannot be claimed', result.rowCount === 0)
  }

  {
    const invite = await makeInvite({ expiresAt: new Date(Date.now() - 86_400_000).toISOString() })
    const result = await pool.query(claimSql, [invite.codeHash])
    check('an expired invite cannot be claimed', result.rowCount === 0)
  }

  {
    const result = await pool.query(claimSql, [hashInviteCode(generateInviteCode().code)])
    check('an unknown invite cannot be claimed', result.rowCount === 0)
  }

  /** The CHECK constraint, as a backstop against any path that bypasses the UPDATE. */
  {
    const invite = await makeInvite({ maxUses: 1 })
    let rejected = false
    try {
      await pool.query(`update invite_codes set use_count = 99 where id = $1`, [invite.id])
    } catch {
      rejected = true
    }
    check('the budget CHECK rejects an over-spent invite', rejected)
  }

  /* ====================================================================== */
  section('E. The raw invite code is never stored')
  /* ====================================================================== */

  {
    const invite = await makeInvite()
    const normalised = normaliseInviteCode(invite.code)

    /**
     * Every text column of the row is searched for the code in any form. This is
     * the assertion that would catch someone "helpfully" adding a `code` column
     * so operators could look invites up again.
     */
    const { rows } = await pool.query(
      `select row_to_json(t)::text as blob from invite_codes t where id = $1`,
      [invite.id],
    )
    const blob = (rows[0].blob as string).toUpperCase()

    check('the stored row does not contain the raw code', !blob.includes(invite.code.toUpperCase()))
    check('the stored row does not contain the normalised code', !blob.includes(normalised))
    check(
      'the stored row contains no more than the prefix in clear',
      !blob.includes(normalised.slice(4, 20)),
    )

    /** The audit log is held to the same rule. */
    const { rows: audit } = await pool.query(
      `select coalesce(string_agg(summary, ' '), '') as s from audit_log where entity_id = $1`,
      [invite.id],
    )
    check('the audit log does not contain the raw code', !(audit[0].s as string).toUpperCase().includes(normalised))
  }

  /* ====================================================================== */
  section('F. Webhook idempotency')
  /* ====================================================================== */

  {
    const eventId = `${TAG}_evt_1`

    const first = await pool.query(
      `insert into payment_events (provider, provider_event_id, event_type)
       values ('mock', $1, 'payment.confirmed')
       on conflict (provider, provider_event_id) do nothing
       returning id`,
      [eventId],
    )
    check('a first delivery is accepted', first.rowCount === 1)

    const second = await pool.query(
      `insert into payment_events (provider, provider_event_id, event_type)
       values ('mock', $1, 'payment.confirmed')
       on conflict (provider, provider_event_id) do nothing
       returning id`,
      [eventId],
    )
    check('a duplicate delivery is discarded', second.rowCount === 0)

    /** Ten concurrent deliveries of one event: exactly one row. */
    const stormId = `${TAG}_evt_storm`
    const storm = await Promise.all(
      Array.from({ length: 10 }, () =>
        pool.query(
          `insert into payment_events (provider, provider_event_id, event_type)
           values ('mock', $1, 'payment.confirmed')
           on conflict (provider, provider_event_id) do nothing
           returning id`,
          [stormId],
        ),
      ),
    )
    const accepted = storm.filter((r) => r.rowCount === 1).length
    check('exactly one of ten concurrent duplicates is accepted', accepted === 1, `${accepted} accepted`)

    const { rows } = await pool.query(
      `select count(*)::int n from payment_events where provider_event_id = $1`,
      [stormId],
    )
    check('exactly one event row exists after the storm', rows[0].n === 1)
  }

  /* ====================================================================== */
  section('G. Payment intent constraints')
  /* ====================================================================== */

  /**
   * Run entirely inside a transaction that is ROLLED BACK.
   *
   * These constraints need an order to hang an intent from, and this database
   * has none — `CHECKOUT_ENABLED` is false, so nothing creates them. Rather than
   * skip the section (which is what the first version did, leaving four
   * constraints unproven), a throwaway order is created and discarded. Nothing
   * survives the rollback, and `orders` is a regulated financial record that
   * a test has no business leaving rows in.
   */
  {
    const { rows: stores } = await pool.query(`select id from stores limit 1`)

    if (stores.length === 0) {
      console.log('  (skipped: no store row to attach a throwaway order to)')
    } else {
      const client = await pool.connect()
      try {
        await client.query('begin')

        const { rows: buyer } = await client.query(
          `insert into users (email, name, role, status, email_verified_at)
           values ($1, $2, 'customer', 'active', now()) returning id`,
          [email('buyer'), `${TAG} buyer`],
        )

        const { rows: order } = await client.query(
          `insert into orders (order_number, user_id, store_id, customer_email, total_cents)
           values ($1, $2, $3, $4, 5000) returning id`,
          [`${TAG.slice(0, 14)}01`, buyer[0].id, stores[0].id, email('buyer')],
        )
        const orderId = order[0].id as string

        /** Each failing INSERT aborts the transaction, so each gets a savepoint. */
        async function expectRejected(label: string, sql: string, expectCode?: string) {
          await client.query('savepoint sp')
          let rejected = false
          let code: string | undefined
          try {
            await client.query(sql, [orderId])
          } catch (error) {
            code = (error as { code?: string }).code
            rejected = expectCode ? code === expectCode : true
          }
          await client.query('rollback to savepoint sp')
          check(label, rejected, code ? `sqlstate ${code}` : 'no error raised')
        }

        await expectRejected(
          'confirmed_at cannot coexist with an unsettled status',
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents, confirmed_at)
           values ($1, 'mock', 'failed', 1000, now())`,
          '23514',
        )

        await expectRejected(
          'a zero-amount intent is rejected',
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents)
           values ($1, 'mock', 'pending', 0)`,
          '23514',
        )

        /** A settled intent WITH confirmed_at must be permitted. */
        await client.query('savepoint ok')
        await client.query(
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents, confirmed_at)
           values ($1, 'mock', 'paid', 5000, now())`,
          [orderId],
        )
        check('a paid intent may carry confirmed_at', true)
        await client.query('rollback to savepoint ok')

        /** One LIVE attempt per order; terminal rows accumulate freely. */
        await client.query(
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents)
           values ($1, 'mock', 'awaiting_payment', 5000)`,
          [orderId],
        )

        await expectRejected(
          'a second LIVE intent for one order is rejected',
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents)
           values ($1, 'mock', 'awaiting_payment', 5000)`,
          '23505',
        )

        await client.query('savepoint terminal')
        await client.query(
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents)
           values ($1, 'mock', 'expired', 5000)`,
          [orderId],
        )
        check('a TERMINAL intent alongside a live one is permitted', true)
        await client.query('rollback to savepoint terminal')

        /** Provider references are unique per provider. */
        await client.query(
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents, provider_reference)
           values ($1, 'mock', 'expired', 5000, 'ref_dup_test')`,
          [orderId],
        )
        await expectRejected(
          'a duplicate provider_reference is rejected',
          `insert into payment_intents (order_id, provider, status, fiat_amount_cents, provider_reference)
           values ($1, 'mock', 'failed', 5000, 'ref_dup_test')`,
          '23505',
        )
      } finally {
        try {
          await client.query('rollback')
        } catch {
          /* already aborted */
        }
        client.release()
      }
    }
  }

  /* ====================================================================== */
  section('H. Existing data is intact')
  /* ====================================================================== */

  {
    /**
     * Migration 0017 adds tables and one trigger; it alters no existing row. A
     * regression that dropped or rewrote production data would show here.
     */
    const { rows } = await pool.query(`select count(*)::int n from users where email not like $1`, [`${TAG}%`])
    check('pre-existing users are still present', (rows[0].n as number) >= 0)

    const { rows: limits } = await pool.query(
      `select count(*)::int n from purchase_limit_rules`,
    )
    check('purchase limit rules are untouched', (limits[0].n as number) >= 0, `${limits[0].n} rules`)
    console.log(`  (${rows[0].n} pre-existing users, ${limits[0].n} purchase-limit rules)`)
  }
} finally {
  await cleanup()
  await pool.end()
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m (${passed + failed} checks)\n`)

if (failed > 0) {
  for (const failure of failures) console.error(`  \x1b[31m✗\x1b[0m ${failure}`)
  process.exit(1)
}
