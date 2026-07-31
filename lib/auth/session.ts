import 'server-only'

import { and, eq, lt, ne } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'

import { db, schema } from '@/lib/db'
import { generateSessionToken, hashToken } from './crypto'

/**
 * Session lifecycle.
 *
 * Sessions are rows, not tokens. The cookie holds an opaque 256-bit value whose
 * SHA-256 is the primary lookup key; the plaintext is never persisted. That
 * gives instant revocation (delete the row) and means a database disclosure
 * hands over no usable sessions.
 */

/**
 * `__Host-` is the strongest cookie prefix available: the browser refuses the
 * cookie unless it is Secure, path=/, and has no Domain attribute — which
 * closes off subdomain cookie-injection entirely. It requires HTTPS, so
 * development falls back to an unprefixed name rather than silently failing to
 * set a cookie on http://localhost.
 */
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
export const SESSION_COOKIE = IS_PRODUCTION
  ? '__Host-cloudmarket_session'
  : 'cloudmarket_session'

/** Idle window. A session unused for this long is dead. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Absolute cap, independent of activity. Without this a session that is used
 * daily lives forever, which turns a single undetected token theft into
 * permanent access. Derived from `created_at`, so it needs no extra column.
 */
const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How stale `last_used_at` may get before it is refreshed. Writing on every
 * request would mean a database write per page view for no benefit.
 */
const SESSION_REFRESH_THRESHOLD_MS = 60 * 60 * 1000

export type SessionUser = {
  id: string
  email: string
  name: string | null
  role: schema.UserRole
  status: schema.UserStatus
  emailVerifiedAt: Date | null
}

export type ActiveSession = {
  sessionId: string
  user: SessionUser
}

async function requestContext() {
  const headerList = await headers()
  return {
    userAgent: headerList.get('user-agent')?.slice(0, 400) ?? null,
    /**
     * Vercel sets `x-forwarded-for`; the left-most entry is the client. Trusted
     * only because this app is always behind Vercel's proxy — on a different
     * host this header is attacker-controlled and must not be believed.
     */
    ipAddress:
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 45) ?? null,
  }
}

/**
 * Issues a new session and sets the cookie.
 *
 * Always called on a *fresh* token — never reusing an existing one — which is
 * what prevents session fixation: an attacker who plants a token in the
 * victim's browser gains nothing, because signing in replaces it.
 */
export async function createSession(userId: string): Promise<string> {
  const token = generateSessionToken()
  const { userAgent, ipAddress } = await requestContext()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const [session] = await db
    .insert(schema.sessions)
    .values({ userId, tokenHash: hashToken(token), expiresAt, userAgent, ipAddress })
    .returning({ id: schema.sessions.id })

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  return session.id
}

/**
 * Resolves the cookie to a live session, or null.
 *
 * Deliberately returns null rather than redirecting — redirect policy belongs
 * to the DAL, so that this can also be used where an anonymous visitor is a
 * legitimate outcome.
 */
export async function resolveSession(): Promise<ActiveSession | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      createdAt: schema.sessions.createdAt,
      lastUsedAt: schema.sessions.lastUsedAt,
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      status: schema.users.status,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.tokenHash, hashToken(token)))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const now = Date.now()
  const idleExpired = row.expiresAt.getTime() <= now
  const absoluteExpired = row.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS <= now

  /**
   * A suspended or soft-deleted user is rejected here rather than at the login
   * screen alone — otherwise suspending someone would not take effect until
   * their existing session happened to expire.
   */
  const userUnusable = row.status === 'suspended' || row.deletedAt !== null

  if (idleExpired || absoluteExpired || userUnusable) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, row.sessionId))
    return null
  }

  if (now - row.lastUsedAt.getTime() > SESSION_REFRESH_THRESHOLD_MS) {
    await db
      .update(schema.sessions)
      .set({ lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(schema.sessions.id, row.sessionId))
  }

  return {
    sessionId: row.sessionId,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      emailVerifiedAt: row.emailVerifiedAt,
    },
  }
}

/**
 * Cheap identity lookup — session and user id only, no join, no expiry
 * handling. Exists so sign-out can record an audit row *before* it deletes the
 * thing being logged; afterwards there is nothing left to attribute the event
 * to.
 */
export async function getCurrentSessionId(): Promise<{
  sessionId: string
  userId: string
} | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  const rows = await db
    .select({ sessionId: schema.sessions.id, userId: schema.sessions.userId })
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashToken(token)))
    .limit(1)

  return rows[0] ?? null
}

/** Signs out the current device only. */
export async function destroyCurrentSession(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value

  if (token) {
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)))
  }

  cookieStore.delete(SESSION_COOKIE)
}

/** Revokes one session by id, scoped to its owner so ids cannot be guessed at. */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
}

/**
 * Revokes every other session for a user.
 *
 * Called on password change. Keeping the current session alive is deliberate —
 * forcing someone to sign in again immediately after they just proved knowledge
 * of both their old and new password is friction with no security benefit.
 */
export async function revokeOtherSessions(
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)))
}

/**
 * Destroys EVERY session for a user, including the caller's own.
 *
 * The password-reset counterpart to `revokeOtherSessions`. Reset is the remedy
 * for "someone else may be in my account", and it is worth nothing if the
 * intruder's cookie outlives it. Unlike a password change, the person
 * completing a reset has proved control of the mailbox but has NOT proved
 * knowledge of the old password — so nothing that existed beforehand is
 * trusted, and no replacement session is created here.
 *
 * Returns how many were destroyed, so the caller can record it.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const removed = await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .returning({ id: schema.sessions.id })
  return removed.length
}

/** Lists a user's live sessions for the account security screen. */
export async function listSessions(userId: string) {
  return db
    .select({
      id: schema.sessions.id,
      userAgent: schema.sessions.userAgent,
      ipAddress: schema.sessions.ipAddress,
      lastUsedAt: schema.sessions.lastUsedAt,
      createdAt: schema.sessions.createdAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .orderBy(schema.sessions.lastUsedAt)
}

/**
 * Housekeeping for expired rows. Not on a request path — expiry is already
 * enforced on read, so this only stops the table growing without bound.
 */
export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()))
}
