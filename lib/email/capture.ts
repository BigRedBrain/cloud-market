import 'server-only'

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EmailMessage, EmailResult, EmailTransport } from './types'

/**
 * Test transport. Records messages to a file and sends nothing anywhere.
 *
 * The E2E suite drives the entire verification and reset loop through this:
 * request → read the captured message → parse the real link out of it → follow
 * it. No provider, no network, no credential, and no way for a test to email a
 * real person.
 *
 * WHY A FILE AND NOT AN ARRAY. It was an array first, and it silently did not
 * work: a Server Action and a Route Handler are separate bundles, and each got
 * its own instance of this module. The action pushed into one array while the
 * debug route read a different, permanently empty one — tokens were being
 * issued correctly and the outbox looked empty. Under a multi-worker server the
 * same split would happen again across processes.
 *
 * A file is the boundary both sides genuinely share. Newline-delimited JSON, so
 * concurrent appends interleave safely: each `send` is one `appendFileSync` of
 * one line.
 *
 * Nothing here runs in production. `lib/email/index.ts` refuses the capture
 * transport when NODE_ENV is production, and the route that reads this file
 * returns 404 there.
 */

const OUTBOX_DIR = join(tmpdir(), 'cloudmarket-test-outbox')
const OUTBOX = join(OUTBOX_DIR, 'messages.ndjson')

type CapturedMessage = EmailMessage & { sentAt: string }

function ensureDir() {
  if (!existsSync(OUTBOX_DIR)) mkdirSync(OUTBOX_DIR, { recursive: true })
}

export const captureTransport: EmailTransport = {
  name: 'capture',
  async send(message: EmailMessage): Promise<EmailResult> {
    ensureDir()
    const record: CapturedMessage = { ...message, sentAt: new Date().toISOString() }
    appendFileSync(OUTBOX, `${JSON.stringify(record)}\n`, 'utf8')
    return { ok: true, id: `capture-${Date.now()}` }
  },
}

export function capturedEmails(): CapturedMessage[] {
  if (!existsSync(OUTBOX)) return []
  return readFileSync(OUTBOX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CapturedMessage]
      } catch {
        /**
         * A torn final line from a concurrent append. Skipping it is correct —
         * the next poll sees it complete.
         */
        return []
      }
    })
}

export function clearCapturedEmails(): void {
  ensureDir()
  writeFileSync(OUTBOX, '', 'utf8')
}
