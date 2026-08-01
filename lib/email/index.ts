import 'server-only'

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { serverEnv } from '@/lib/env'

import { captureTransport } from './capture'
import { consoleTransport } from './console'
import { createResendTransport } from './resend'
import type { EmailMessage, EmailResult, EmailTransport } from './types'

/**
 * Transport selection, and the one rule that matters:
 *
 *   PRODUCTION FAILS CLOSED. IT NEVER FALLS BACK TO CONSOLE.
 *
 * A misconfigured production deployment that quietly printed reset links to a
 * server log instead of emailing them would be worse than one that refuses to
 * send at all. It would look healthy, customers would sit waiting for mail that
 * was never sent, and every reset link would be sitting in a log aggregator —
 * a credential, in plaintext, somewhere it was never meant to be. So in
 * production the only permitted transport is `resend`, and if its configuration
 * is missing this throws.
 *
 * The throw is deliberately at SEND time rather than at import time. Boot-time
 * validation would take the whole storefront down over a missing email key —
 * browsing, the bag and sign-in do not need email, and a retailer losing their
 * shop window because password resets are misconfigured is the wrong blast
 * radius. Instead the failure is contained to the flows that actually need it,
 * where the caller turns it into `EMAIL_SEND_FAILED` and a retry-able message.
 */
function selectTransport(): EmailTransport {
  const env = serverEnv()
  const configured = env.EMAIL_PROVIDER

  if (env.NODE_ENV === 'production') {
    if (configured !== 'resend') {
      throw new Error(
        `Email is misconfigured: EMAIL_PROVIDER is "${configured}" in production. ` +
          'Only "resend" may send in production — console and capture are never permitted there.',
      )
    }
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
      throw new Error(
        'Email is misconfigured: RESEND_API_KEY and EMAIL_FROM are required in production.',
      )
    }
    return createResendTransport({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
    })
  }

  switch (configured) {
    case 'capture':
      return captureTransport
    case 'resend':
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
        throw new Error(
          'EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM.',
        )
      }
      return createResendTransport({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        replyTo: env.EMAIL_REPLY_TO,
      })
    default:
      return consoleTransport
  }
}

/**
 * Sends, and never throws for a delivery problem.
 *
 * A configuration error still throws — that is a deployment fault the operator
 * must see — but it is caught here and converted, so no caller has to decide
 * between leaking account existence through a 500 and swallowing a real outage.
 */
/**
 * Test-only outage simulation.
 *
 * A FILE, not a module variable — a Route Handler and a Server Action are
 * separate bundles with separate module instances, so a flag set by one would
 * be invisible to the other. That is the same trap the capture transport fell
 * into, and the same fix.
 *
 * Unreachable in production twice over: the toggle route 404s there, and the
 * check below requires the capture transport, which production refuses.
 */
const OUTAGE_FLAG = join(tmpdir(), 'cloudmarket-test-outbox', 'outage.flag')

export function setSimulatedOutage(on: boolean): void {
  mkdirSync(dirname(OUTAGE_FLAG), { recursive: true })
  if (on) writeFileSync(OUTAGE_FLAG, '1', 'utf8')
  else if (existsSync(OUTAGE_FLAG)) rmSync(OUTAGE_FLAG)
}

function simulatedOutage(): boolean {
  const env = serverEnv()
  if (env.NODE_ENV === 'production' || env.EMAIL_PROVIDER !== 'capture') return false
  return existsSync(OUTAGE_FLAG)
}

/**
 * Sends, and never throws for a delivery problem.
 *
 * A configuration error still throws — that is a deployment fault the operator
 * must see — but it is caught here and converted, so no caller has to decide
 * between leaking account existence through a 500 and swallowing a real outage.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (simulatedOutage()) {
    return { ok: false, error: 'simulated provider outage (test only)' }
  }

  let transport: EmailTransport
  try {
    transport = selectTransport()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'transport unavailable' }
  }
  return transport.send(message)
}

/** Which transport would be used. For diagnostics and tests; never sends. */
export function activeTransportName(): string {
  try {
    return selectTransport().name
  } catch {
    return 'misconfigured'
  }
}

export type { EmailMessage, EmailResult, EmailTransport }
