import { defineConfig } from 'drizzle-kit'

import { assertUsableEnv, loadEnvFile } from './scripts/lib/env-file.mjs'

/**
 * drizzle-kit runs as a plain Node process outside the Next.js runtime, so it
 * neither loads `.env.local` automatically nor shares the app's env module.
 * It is deliberately decoupled from `lib/env.ts` — migrations should not
 * require the app's public runtime variables to be present.
 *
 * `loadEnvFile` replaced `dotenv` here because THIS is the file that decides
 * which database a migration writes to. It strips a UTF-8 byte order mark
 * before parsing, and `assertUsableEnv` refuses to continue if the environment
 * already contains a BOM-mangled variable NAME — the state Node's `--env-file`
 * parser produces from a `.env.local` saved by a Windows editor, in which
 * `DATABASE_URL` is simultaneously "set" and unreadable. Under the
 * `DATABASE_URL_UNPOOLED ?? DATABASE_URL` preference below, that does not fail:
 * it silently selects the other variable, which is a different database.
 */
assertUsableEnv()
loadEnvFile('.env.local')
loadEnvFile('.env')

// Prefer the direct (non-pooled) endpoint: DDL over a pooler can fail mid-run.
const connectionString =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    'Missing DATABASE_URL (or DATABASE_URL_UNPOOLED). Copy .env.example to .env.local and fill it in.',
  )
}

export default defineConfig({
  schema: './lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: connectionString },
  strict: true,
  verbose: true,
})
