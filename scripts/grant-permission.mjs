/**
 * Grants and revokes named permissions.
 *
 *   node scripts/grant-permission.mjs --email=someone@example.com --list
 *   node scripts/grant-permission.mjs --email=… --grant=compliance_admin \
 *     --reason="Named compliance officer, board minute 2026-07-14" --confirm
 *   node scripts/grant-permission.mjs --email=… --revoke=compliance_admin --confirm
 *
 * WHY THIS IS NOT A SCREEN IN THE ADMIN APP
 *
 * `compliance_admin` is the permission to change the legal caps this business
 * operates under. If it could be granted from the same application it governs,
 * then compromising any administrator account would be enough to grant it to
 * yourself and then use it — the separation would be decorative.
 *
 * Granting therefore requires direct database access, which is a different
 * credential held by fewer people and logged somewhere this application cannot
 * reach. That is deliberately inconvenient. It is supposed to happen rarely,
 * with a name and a reason attached.
 *
 * REVOCATION IS A TIMESTAMP, NOT A DELETE. The row stays so that "who could
 * publish a limit change in March" remains answerable.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const EMAIL = flag('email')
const GRANT = flag('grant')
const REVOKE = flag('revoke')
const REASON = flag('reason')
const LIST = process.argv.includes('--list')
const CONFIRM = process.argv.includes('--confirm')

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

async function main() {
  if (!connectionString) {
    console.error('No connection string resolved. Set DATABASE_URL_UNPOOLED or DATABASE_URL.')
    process.exitCode = 1
    return
  }
  if (!EMAIL) {
    console.error('--email is required.')
    process.exitCode = 1
    return
  }
  if (!LIST && !GRANT && !REVOKE) {
    console.error('Give one of --list, --grant=<permission> or --revoke=<permission>.')
    process.exitCode = 1
    return
  }
  if (GRANT && !REASON) {
    console.error('--reason is required when granting. It is the record of who authorised it.')
    process.exitCode = 1
    return
  }

  /** Same fingerprint the migration gate prints. No credential is displayed. */
  const endpoint = createHash('sha256')
    .update(new URL(connectionString).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

  console.log('Permissions\n')
  console.log(`  target endpoint id: ${endpoint}`)
  console.log(`  account:            ${EMAIL}\n`)

  const pool = new Pool({ connectionString })
  try {
    const { rows: users } = await pool.query(
      'select id, email, role from users where lower(email) = lower($1)',
      [EMAIL],
    )
    if (users.length === 0) {
      console.error('No account with that address.')
      process.exitCode = 1
      return
    }
    const user = users[0]
    console.log(`  role:               ${user.role}`)

    const showGrants = async () => {
      const { rows } = await pool.query(
        `select permission, granted_at, revoked_at, reason
           from user_permissions where user_id = $1
          order by granted_at desc`,
        [user.id],
      )
      if (rows.length === 0) {
        console.log('  grants:             none')
        return
      }
      console.log('  grants:')
      for (const row of rows) {
        const state = row.revoked_at
          ? `revoked ${row.revoked_at.toISOString().slice(0, 10)}`
          : 'ACTIVE'
        console.log(
          `    ${row.permission.padEnd(18)} ${state.padEnd(22)} ` +
            `granted ${row.granted_at.toISOString().slice(0, 10)}` +
            (row.reason ? `  — ${row.reason}` : ''),
        )
      }
    }

    if (LIST) {
      await showGrants()
      return
    }

    if (!CONFIRM) {
      await showGrants()
      console.log(
        `\nWould ${GRANT ? `grant ${GRANT}` : `revoke ${REVOKE}`}. Nothing was written.`,
      )
      console.log('Rerun with --confirm to apply.')
      return
    }

    if (GRANT) {
      /**
       * The partial unique index permits one live grant per user per
       * permission, so a repeat is a no-op rather than a duplicate.
       */
      const { rowCount } = await pool.query(
        `insert into user_permissions (user_id, permission, reason)
         values ($1, $2, $3)
         on conflict do nothing`,
        [user.id, GRANT, REASON],
      )
      if (rowCount === 0) {
        console.log(`\n${GRANT} is already granted and active. Nothing changed.`)
      } else {
        await pool.query(
          `insert into audit_log (event, user_id, entity_type, summary)
           values ('PERMISSION_GRANTED', $1, 'permission', $2)`,
          [user.id, `${GRANT}: ${REASON}`.slice(0, 300)],
        )
        console.log(`\nGranted ${GRANT}.`)
      }
    }

    if (REVOKE) {
      const { rowCount } = await pool.query(
        `update user_permissions set revoked_at = now()
          where user_id = $1 and permission = $2 and revoked_at is null`,
        [user.id, REVOKE],
      )
      if (rowCount === 0) {
        console.log(`\nNo active ${REVOKE} grant to revoke. Nothing changed.`)
      } else {
        await pool.query(
          `insert into audit_log (event, user_id, entity_type, summary)
           values ('PERMISSION_REVOKED', $1, 'permission', $2)`,
          [user.id, REVOKE],
        )
        console.log(`\nRevoked ${REVOKE}. The grant row was kept, with revoked_at set.`)
      }
    }

    console.log()
    await showGrants()
  } catch (error) {
    console.error(`\nABORTED: ${error.message}`)
    process.exitCode = 1
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
