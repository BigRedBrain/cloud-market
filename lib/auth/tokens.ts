import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'

/**
 * One-time tokens for email verification and password reset.
 *
 * ONE IMPLEMENTATION, TWO PURPOSES, on purpose. If verification and reset each
 * had their own issue/consume code they would drift, and the one that drifted
 * would be the one nobody was looking at. `purpose` is part of every lookup, so
 * a verification token presented at the reset endpoint is simply not found.
 *
 * THE RAW TOKEN EXISTS FOR ONE FUNCTION CALL. `issueToken` returns it so the
 * caller can build a link; only its SHA-256 is written. It is never stored,
 * never logged, never audited, and never returned by any read path. A database
 * disclosure yields hashes that cannot be replayed as links — the same property
 * session cookies and guest bag tokens have, for the same reason.
 *
 * WHY SHA-256 AND NOT SCRYPT. Passwords are low-entropy and need a slow hash to
 * survive offline guessing. These tokens are 256 bits from a CSPRNG: there is
 * no dictionary to try, brute force is not a threat model, and a fast hash lets
 * the lookup use a unique index instead of scanning every row to compare.
 */

const TOKEN_BYTES = 32

/**
 * Verification is long because people read mail on their own schedule, and a
 * stale verification link is low risk — at worst it confirms an address the
 * account already claimed.
 *
 * Reset is short because a reset link IS an authentication credential. It sits
 * in an inbox that may be shared, synced to a lost phone, or still open on a
 * borrowed laptop. One hour is the common floor and short enough that a
 * forgotten link is rarely still live.
 */
export const TOKEN_TTL_MS = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
} as const

/** Minimum gap between sends, per account per purpose. */
export const RESEND_COOLDOWN_MS = 60 * 1000
/** Maximum sends per rolling 24 hours, per account per purpose. */
export const MAX_SENDS_PER_DAY = 5
const DAY_MS = 24 * 60 * 60 * 1000

export type TokenPurpose = schema.TokenPurpose

/**
 * `db` or a transaction handle. Drizzle's transaction callback receives an
 * object with the same query surface, so anything written against this type
 * works identically inside and outside a transaction.
 */
export type DbExecutor = Pick<typeof db, 'update' | 'select' | 'insert' | 'delete'>

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/* -------------------------------------------------------------------------- */
/* Throttling                                                                  */
/* -------------------------------------------------------------------------- */

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'cooldown' | 'daily_cap'; retryAfterMs: number }

/**
 * Send throttling, computed from rows this system already writes.
 *
 * No Redis, no rate-limit table, no new infrastructure: `verification_tokens`
 * records `created_at` and is indexed on `(user_id, purpose, created_at)`, which
 * is exactly the question being asked. The limit is per account per purpose, so
 * exhausting password-reset sends cannot also block email verification.
 *
 * This bounds the real abuse: no single address can be mailed more than
 * MAX_SENDS_PER_DAY times a day no matter how many source addresses an attacker
 * rotates through — because the limit follows the account, not the IP. What it
 * does not bound is aggregate volume across many accounts, which is a provider
 * quota concern and is recorded as production hardening in ACCOUNT-RECOVERY.md.
 */
export async function checkSendThrottle(
  userId: string,
  purpose: TokenPurpose,
): Promise<ThrottleVerdict> {
  const since = new Date(Date.now() - DAY_MS)

  const [row] = await db
    .select({
      recent: sql<number>`count(*)::int`,
      latest: sql<Date | null>`max(${schema.verificationTokens.createdAt})`,
    })
    .from(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.userId, userId),
        eq(schema.verificationTokens.purpose, purpose),
        gt(schema.verificationTokens.createdAt, since),
      ),
    )

  const recent = row?.recent ?? 0
  const latest = row?.latest ? new Date(row.latest) : null

  if (latest) {
    const elapsed = Date.now() - latest.getTime()
    if (elapsed < RESEND_COOLDOWN_MS) {
      return { allowed: false, reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS - elapsed }
    }
  }

  if (recent >= MAX_SENDS_PER_DAY) {
    const oldestRelevant = latest ? latest.getTime() : Date.now()
    return {
      allowed: false,
      reason: 'daily_cap',
      retryAfterMs: Math.max(0, oldestRelevant + DAY_MS - Date.now()),
    }
  }

  return { allowed: true }
}

/* -------------------------------------------------------------------------- */
/* Issue                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Issues a token and retires every outstanding one for the same purpose.
 *
 * ONE CANONICAL LINK AT A TIME. Requesting a second reset must not leave the
 * first live: if a customer resets because they believe their mail was read,
 * the earlier link in that inbox has to stop working. The same rule is applied
 * to verification, where it also removes a real support question — "which of
 * these three emails do I click" has one answer, the newest.
 *
 * Superseded rows are marked `superseded_at`, NOT `consumed_at`, so the log
 * still distinguishes "the customer used this" from "we replaced it".
 *
 * Returns the RAW token. It is never persisted; the caller uses it to build one
 * link and then it is gone.
 */
export async function issueToken(
  userId: string,
  purpose: TokenPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[purpose])

  await db.transaction(async (tx) => {
    await tx
      .update(schema.verificationTokens)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(schema.verificationTokens.userId, userId),
          eq(schema.verificationTokens.purpose, purpose),
          isNull(schema.verificationTokens.consumedAt),
          isNull(schema.verificationTokens.supersededAt),
        ),
      )

    await tx.insert(schema.verificationTokens).values({
      userId,
      tokenHash: hashToken(token),
      purpose,
      expiresAt,
    })
  })

  return { token, expiresAt }
}

/* -------------------------------------------------------------------------- */
/* Consume                                                                     */
/* -------------------------------------------------------------------------- */

export type TokenFailure = 'not_found' | 'already_consumed' | 'expired' | 'superseded'

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: TokenFailure }

/**
 * Looks at a token WITHOUT consuming it.
 *
 * This is what a GET is allowed to do. A link in an email is opened by things
 * that are not the customer — corporate mail security, link-preview bots,
 * browser prefetchers, antivirus appliances — and every one of them issues a
 * GET. If arriving at a URL performed the state change, those systems would
 * verify addresses and burn reset links on the customer's behalf, and the
 * customer would find a dead link and a confirmed account they never
 * confirmed.
 *
 * So the rule is: GET inspects, POST consumes. This function is the inspect
 * half. It reads, decides nothing, and writes nothing.
 */
export async function inspectToken(
  rawToken: string,
  purpose: TokenPurpose,
): Promise<{ usable: true; userId: string } | { usable: false; reason: TokenFailure }> {
  const [row] = await db
    .select({
      userId: schema.verificationTokens.userId,
      consumedAt: schema.verificationTokens.consumedAt,
      supersededAt: schema.verificationTokens.supersededAt,
      expiresAt: schema.verificationTokens.expiresAt,
    })
    .from(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, hashToken(rawToken)),
        eq(schema.verificationTokens.purpose, purpose),
      ),
    )
    .limit(1)

  if (!row) return { usable: false, reason: 'not_found' }
  if (row.consumedAt) return { usable: false, reason: 'already_consumed' }
  if (row.supersededAt) return { usable: false, reason: 'superseded' }
  if (row.expiresAt.getTime() <= Date.now()) return { usable: false, reason: 'expired' }
  return { usable: true, userId: row.userId }
}

/**
 * The atomic claim, executable inside a caller's transaction.
 *
 * Takes an executor rather than using `db` directly, so consumption can share a
 * transaction with the mutation it authorises. That is what makes "the token is
 * spent" and "the password changed" a single all-or-nothing fact: if the
 * password write fails, the ROLLBACK un-consumes the token and the customer's
 * link still works. Without it, a failure in between would leave someone locked
 * out holding a link that no longer opens anything.
 *
 * The UPDATE remains the check — validity and consumption in one statement, so
 * two concurrent POSTs cannot both claim the same token.
 */
export async function claimTokenWithin(
  tx: DbExecutor,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<{ userId: string } | null> {
  const [claimed] = await tx
    .update(schema.verificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, hashToken(rawToken)),
        eq(schema.verificationTokens.purpose, purpose),
        isNull(schema.verificationTokens.consumedAt),
        isNull(schema.verificationTokens.supersededAt),
        gt(schema.verificationTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: schema.verificationTokens.userId })

  return claimed ?? null
}

/** Removes a token that was issued but never delivered. See `issueAndSend`. */
export async function discardToken(rawToken: string, purpose: TokenPurpose): Promise<void> {
  await db
    .delete(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, hashToken(rawToken)),
        eq(schema.verificationTokens.purpose, purpose),
      ),
    )
}

/**
 * Consumes a token, atomically.
 *
 * The UPDATE is the check. Validity and consumption happen in one statement, so
 * two simultaneous clicks — a double-tap, a link scanner racing the human —
 * cannot both succeed: the second finds `consumed_at` already set and matches
 * nothing.
 *
 *     UPDATE ... SET consumed_at = now()
 *      WHERE token_hash = $1 AND purpose = $2
 *        AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now()
 *   RETURNING user_id
 *
 * On failure a SECOND query establishes why. That is a deliberate split: the
 * hot path stays one statement, and the diagnostic only runs when something
 * already went wrong. The reason is for the audit log and for choosing wording
 * like "this link has expired" — the *caller* decides how much of it a visitor
 * is allowed to see, and on unauthenticated surfaces the answer is "nothing
 * specific".
 */
export async function consumeToken(
  rawToken: string,
  purpose: TokenPurpose,
): Promise<ConsumeResult> {
  const tokenHash = hashToken(rawToken)

  const [claimed] = await db
    .update(schema.verificationTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, tokenHash),
        eq(schema.verificationTokens.purpose, purpose),
        isNull(schema.verificationTokens.consumedAt),
        isNull(schema.verificationTokens.supersededAt),
        gt(schema.verificationTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: schema.verificationTokens.userId })

  if (claimed) return { ok: true, userId: claimed.userId }

  const [existing] = await db
    .select({
      consumedAt: schema.verificationTokens.consumedAt,
      supersededAt: schema.verificationTokens.supersededAt,
      expiresAt: schema.verificationTokens.expiresAt,
      userId: schema.verificationTokens.userId,
    })
    .from(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, tokenHash),
        eq(schema.verificationTokens.purpose, purpose),
      ),
    )
    .limit(1)

  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.consumedAt) return { ok: false, reason: 'already_consumed' }
  if (existing.supersededAt) return { ok: false, reason: 'superseded' }
  return { ok: false, reason: 'expired' }
}

/**
 * Was this token consumed earlier, and by whom?
 *
 * Used only by email verification, to stay correct when a corporate link
 * scanner or mail-client prefetch follows the link before the human does. In
 * that case the token is legitimately consumed and the address is legitimately
 * verified, so showing the customer a failure would be both confusing and
 * untrue. Nothing is re-verified and no token becomes reusable — this only
 * changes what is *displayed*.
 */
export async function findConsumedToken(
  rawToken: string,
  purpose: TokenPurpose,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: schema.verificationTokens.userId })
    .from(schema.verificationTokens)
    .where(
      and(
        eq(schema.verificationTokens.tokenHash, hashToken(rawToken)),
        eq(schema.verificationTokens.purpose, purpose),
      ),
    )
    .limit(1)

  return row ?? null
}
