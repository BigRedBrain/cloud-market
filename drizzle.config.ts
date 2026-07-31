import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit runs as a plain Node process outside the Next.js runtime, so it
 * neither loads `.env.local` automatically nor shares the app's env module.
 * It is deliberately decoupled from `lib/env.ts` — migrations should not
 * require the app's public runtime variables to be present.
 */
loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })

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
