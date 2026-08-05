import 'server-only'

import { createHmac } from 'node:crypto'
import { headers } from 'next/headers'

import { db, schema } from '@/lib/db'
import { serverEnv } from '@/lib/env'
import type { AuditEvent } from '@/lib/db/schema'

/**
 * Security audit logging.
 *
 * WHY HMAC AND NOT SHA-256:
 *
 * IPv4 is 2^32 values. A plain SHA-256 of an IP address can be reversed by
 * exhaustive search in seconds on a laptop, so "hashing" it would be
 * pseudonymisation in name only — the log would be as identifying as storing
 * the address in clear, while giving everyone reading it false confidence.
 * User-agent strings have similarly low real-world entropy.
 *
 * Keying the digest with `AUTH_SECRET` fixes that: without the secret the
 * digest cannot be brute-forced back to an address, while the same address
 * still produces the same value, so correlation — "these ten failed logins came
 * from one place" — keeps working. That correlation is the entire operational
 * value of the field.
 *
 * Consequence worth knowing: rotating AUTH_SECRET breaks correlation with rows
 * written before the rotation. That is the correct trade and is documented in
 * AUTHENTICATION.md.
 */

function keyedDigest(value: string | null): string | null {
  if (!value) return null
  return createHmac('sha256', serverEnv().AUTH_SECRET).update(value).digest('hex')
}

type AuditContext = {
  event: AuditEvent
  userId?: string | null
  sessionId?: string | null
  /** Supplied when the caller already has them; otherwise read from headers. */
  ipAddress?: string | null
  userAgent?: string | null
  /** What the event was about — "campaign", "media" — and which row. */
  entityType?: string | null
  entityId?: string | null
  /** Readable summary, so the log makes sense without joining. */
  summary?: string | null
}

/**
 * Appends an audit row.
 *
 * Never throws. An audit write failing must not take down a sign-in — losing a
 * log line is bad, but refusing to authenticate a legitimate customer because
 * the log table is unavailable is worse. Failures are reported to the server
 * console so they surface in platform logging.
 */
export async function recordAuditEvent(context: AuditContext): Promise<void> {
  try {
    let { ipAddress, userAgent } = context

    if (ipAddress === undefined || userAgent === undefined) {
      /**
       * Fails soft, and it must.
       *
       * `headers()` throws outside a request scope — a scheduled sweep, a
       * background job, a script. This read used to sit in the same `try` as
       * the INSERT below, so in those contexts the throw skipped the write
       * entirely and the event was silently lost. Losing the IP is a
       * degradation; losing the fact that a compliance action happened is a
       * hole in the record. Take the row without the metadata.
       */
      try {
        const headerList = await headers()
        ipAddress ??= headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
        userAgent ??= headerList.get('user-agent') ?? null
      } catch {
        ipAddress ??= null
        userAgent ??= null
      }
    }

    await db.insert(schema.auditLog).values({
      event: context.event,
      userId: context.userId ?? null,
      sessionId: context.sessionId ?? null,
      ipHash: keyedDigest(ipAddress),
      userAgentHash: keyedDigest(userAgent),
      entityType: context.entityType ?? null,
      entityId: context.entityId ?? null,
      summary: context.summary?.slice(0, 300) ?? null,
    })
  } catch (error) {
    console.error('[audit] failed to record event', context.event, error)
  }
}

/**
 * Direct-write variant for contexts with no request headers — scripts, tests,
 * and background jobs. Keeps `recordAuditEvent` free of optional-header
 * branching at every call site.
 */
export async function recordAuditEventHeadless(
  context: Omit<AuditContext, 'ipAddress' | 'userAgent'>,
): Promise<void> {
  await recordAuditEvent({ ...context, ipAddress: null, userAgent: null })
}
