import { NextResponse } from 'next/server'

import { capturedEmails, clearCapturedEmails } from '@/lib/email/capture'
import { serverEnv } from '@/lib/env'

/**
 * Reads the CaptureTransport's in-memory outbox.
 *
 * WHY THIS EXISTS: the E2E suite runs as a separate process from the server, so
 * it cannot reach the capture array directly. Without this it could only test
 * the flow by reading tokens out of the database — which would prove the token
 * works while proving nothing about whether an email was ever produced, or
 * whether the link inside it is correct. Parsing the real link out of the real
 * message is the point.
 *
 * WHY IT IS SAFE: it returns 404 unless BOTH conditions hold — not in
 * production, and the capture transport is actually selected. In production the
 * transport can only ever be `resend` (lib/email/index.ts refuses anything
 * else), so this route has nothing to return there and says so with the same
 * response a nonexistent route gives. No message content, no token, and no
 * indication that the route exists at all.
 */
function unavailable() {
  return new NextResponse('Not found', { status: 404 })
}

function guard(): boolean {
  const env = serverEnv()
  return env.NODE_ENV !== 'production' && env.EMAIL_PROVIDER === 'capture'
}

export async function GET() {
  if (!guard()) return unavailable()
  return NextResponse.json({ messages: capturedEmails() })
}

export async function DELETE() {
  if (!guard()) return unavailable()
  clearCapturedEmails()
  return NextResponse.json({ cleared: true })
}
