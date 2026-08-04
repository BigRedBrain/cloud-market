/**
 * Removes a test account left behind by an interrupted verification run.
 *
 *   $env:DATABASE_URL = "<the real pooled connection string>"
 *
 *   node scripts/cleanup-test-account.mjs <base-url> --allow-production --inspect
 *   node scripts/cleanup-test-account.mjs <base-url> --allow-production --delete --user-id=<uuid>
 *
 * TWO PHASES, AND THE SPLIT IS THE WHOLE SAFETY MODEL.
 *
 * `--inspect` is read-only. It searches for rows that look like verification
 * residue and prints them with their exact ids. `--delete` accepts one id and
 * touches nothing else.
 *
 * Searching by pattern is fine — it is how you FIND a candidate. Deleting by
 * pattern is not, and nothing here does it: the DELETE statements are keyed on
 * a UUID a human read and passed in. That distinction is the lesson from the
 * Phase 3 incident, where a shape-matching delete written to remove one run's
 * own rows destroyed two unrelated production audit rows.
 *
 * WHY THE ADDRESS IS A SAFE SEARCH KEY. The verifiers generate
 * `browser.<epoch-ms>@example.invalid`. `.invalid` is reserved by RFC 2606 and
 * can never be delivered to, so no real customer can hold one — but the script
 * still refuses to delete anything until you name the id.
 */
import { createHash } from 'node:crypto'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloudmarket.cc'
const ALLOW = process.argv.includes('--allow-production')
const INSPECT = process.argv.includes('--inspect')
const DELETE = process.argv.includes('--delete')
const USER_ID = (process.argv.find((a) => a.startsWith('--user-id=')) ?? '').slice(10)

function requireConnectionString(value, name = 'DATABASE_URL') {
  if (!value) {
    console.error(`${name} is not set.\n  PowerShell:  $env:${name} = "postgresql://…"`)
    process.exit(1)
  }
  if (!/^postgres(ql)?:\/\//.test(value)) {
    console.error(`${name} does not look like a connection string.\n` +
      `  It currently starts with: ${value.slice(0, 24)}…`)
    process.exit(1)
  }
  return value
}

if (!ALLOW || (!INSPECT && !DELETE)) {
  console.error('Usage: node scripts/cleanup-test-account.mjs <url> --allow-production --inspect')
  console.error('       node scripts/cleanup-test-account.mjs <url> --allow-production --delete --user-id=<uuid>')
  process.exit(1)
}
if (DELETE && !/^[0-9a-f-]{36}$/i.test(USER_ID)) {
  console.error('--delete requires --user-id=<uuid>, taken from an --inspect run.')
  process.exit(1)
}
requireConnectionString(process.env.DATABASE_URL)

const hostFp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

let pool = null
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

/**
 * Proves the connection is the database the deployed app uses, before reading
 * or writing anything. A wrong-target cleanup is how you turn a tidy-up into an
 * incident.
 */
async function assertTarget() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  const mine = hostFp(process.env.DATABASE_URL)
  console.log(`deployed app database:  ${health.database?.fingerprint} (${health.environment})`)
  console.log(`this script's database: ${mine}`)
  if (!health.database?.fingerprint || health.database.fingerprint !== mine) {
    console.error('\nREFUSING: this is not the database behind ' + BASE)
    process.exitCode = 1
    return false
  }
  console.log('target confirmed\n')
  pool = new Pool({ connectionString: process.env.DATABASE_URL })
  return true
}

/** Everything the sign-up path can create, keyed on the user. */
async function relatedRows(userId) {
  const [counts] = await sql(
    `select (select count(*)::int from sessions where user_id = $1)             as sessions,
            (select count(*)::int from verification_tokens where user_id = $1)  as tokens,
            (select count(*)::int from audit_log where user_id = $1)            as audit,
            (select count(*)::int from carts where user_id = $1)                as carts`,
    [userId])
  return counts
}

async function main() {
  if (!(await assertTarget())) return

  if (INSPECT) {
    console.log('[1] Candidate test accounts (READ ONLY — nothing is deleted)\n')

    /**
     * A search, not a delete. Reserved-TLD addresses cannot belong to a real
     * customer, which is what makes this a safe way to narrow down.
     */
    const candidates = await sql(
      `select id, email, name, status, created_at, email_verified_at
         from users
        where email like '%@example.invalid'
        order by created_at desc`)

    if (candidates.length === 0) {
      console.log('  none found — nothing was left behind, or it is already gone.')
    }

    for (const row of candidates) {
      const related = await relatedRows(row.id)
      console.log(`  user_id : ${row.id}`)
      console.log(`  email   : ${row.email}`)
      console.log(`  name    : ${row.name}`)
      console.log(`  status  : ${row.status}   verified: ${row.email_verified_at ? 'yes' : 'no'}`)
      console.log(`  created : ${new Date(row.created_at).toISOString()}`)
      console.log(`  related : sessions=${related.sessions} tokens=${related.tokens} ` +
        `audit=${related.audit} carts=${related.carts}`)
      const events = await sql(
        'select id, event, occurred_at from audit_log where user_id=$1 order by occurred_at',
        [row.id])
      for (const e of events) {
        console.log(`            audit ${e.id}  ${e.event}  ${new Date(e.occurred_at).toISOString()}`)
      }
      console.log('')
    }

    const [total] = await sql(
      `select (select count(*)::int from users) u, (select count(*)::int from audit_log) a`)
    console.log(`  production totals right now: users=${total.u} audit_log=${total.a}`)
    console.log('\n  To remove one, re-run with:')
    console.log('    --delete --user-id=<the user_id above>')
  }

  if (DELETE) {
    console.log(`[1] Deleting exactly one account: ${USER_ID}\n`)

    const [target] = await sql(
      'select id, email, created_at from users where id=$1', [USER_ID])
    if (!target) {
      console.log('  no user with that id — nothing to do.')
      await pool.end()
      return
    }

    /**
     * A last guard against a mistyped id. Anything that is not a reserved-TLD
     * test address is refused outright — this tool has no business deleting a
     * customer, whatever id it is handed.
     */
    if (!target.email.endsWith('@example.invalid')) {
      console.error(`  REFUSING: ${target.email} is not a reserved-TLD test address.`)
      console.error('  This tool only removes verification residue.')
      process.exitCode = 1
      await pool.end()
      return
    }

    console.log(`  email  : ${target.email}`)
    console.log(`  created: ${new Date(target.created_at).toISOString()}`)

    const before = await relatedRows(USER_ID)
    console.log(`  before : sessions=${before.sessions} tokens=${before.tokens} ` +
      `audit=${before.audit} carts=${before.carts}`)

    /**
     * Every statement is keyed on this one UUID, generated during the
     * interrupted run. Nothing pre-existing can reference it, so no row outside
     * that run is reachable from here. audit_log has no foreign key by design —
     * the log outlives what it describes — so it is removed explicitly rather
     * than by cascade.
     */
    await sql('delete from cart_lines where cart_id in (select id from carts where user_id=$1)', [USER_ID])
    await sql('delete from carts where user_id=$1', [USER_ID])
    await sql('delete from verification_tokens where user_id=$1', [USER_ID])
    await sql('delete from sessions where user_id=$1', [USER_ID])
    await sql('delete from audit_log where user_id=$1', [USER_ID])
    await sql('delete from users where id=$1', [USER_ID])

    const after = await relatedRows(USER_ID)
    const [gone] = await sql('select count(*)::int n from users where id=$1', [USER_ID])
    console.log(`  after  : sessions=${after.sessions} tokens=${after.tokens} ` +
      `audit=${after.audit} carts=${after.carts}`)
    console.log(`  user removed: ${gone.n === 0}`)

    const [remaining] = await sql(
      `select count(*)::int n from users where email like '%@example.invalid'`)
    console.log(`\n  test accounts still present: ${remaining.n}`)

    const [total] = await sql(
      `select (select count(*)::int from users) u, (select count(*)::int from audit_log) a`)
    console.log(`  production totals now: users=${total.u} audit_log=${total.a}`)
  }

  await pool.end()
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  await pool?.end().catch(() => {})
  process.exitCode = 1
})
