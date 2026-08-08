import 'server-only'

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import type { DbExecutor } from '@/lib/auth/tokens'
import { hashInviteCode, isInviteSystemConfigured, looksLikeInviteCode } from './codes'

/**
 * Invite redemption — the concurrency-critical half of registration.
 *
 * THE PROBLEM. An invite with `max_uses = 1` is submitted by two people in the
 * same millisecond. The obvious implementation — read the invite, check
 * `use_count < max_uses`, create the user, write `use_count + 1` — has both
 * reads returning 0, both checks passing, and both accounts created. The invite
 * is used twice and the counter says 1. On a private storefront that is an
 * unauthorised account, which is the exact thing the invite system exists to
 * prevent.
 *
 * THE FIX is to never read-then-write. The claim is a SINGLE conditional UPDATE
 * whose WHERE clause contains every condition that makes the invite usable and
 * whose SET increments the counter:
 *
 *     update invite_codes set use_count = use_count + 1
 *      where code_hash = $1
 *        and deactivated_at is null
 *        and (expires_at is null or expires_at > now())
 *        and use_count < max_uses
 *
 * Postgres takes a row lock for the UPDATE. The second transaction blocks on it,
 * and when the first commits, re-evaluates its WHERE clause against the NEW row
 * version — where `use_count` is now 1 and the predicate no longer holds. It
 * matches zero rows and is refused. No advisory lock, no SERIALIZABLE, no retry
 * loop: the correctness comes from putting the check and the write in one
 * statement.
 *
 * WHY IT RUNS IN THE CALLER'S TRANSACTION. `redeemInviteCodeWithin` takes a `tx`
 * rather than opening its own, so the claim, the `users` INSERT and the
 * redemption record are one atomic unit. That is what satisfies both halves of
 * section P: an account can never be created without consuming an invite, AND a
 * registration that fails afterwards — a duplicate email, a constraint
 * violation, a dropped connection — rolls the increment back rather than
 * burning a use on an account that does not exist.
 *
 * The `invite_codes_use_count_within_budget` CHECK constraint is the backstop
 * beneath all of this, so even a future code path that bypassed this function
 * could not overspend an invite.
 */

export type RedemptionFailure =
  /** The pepper is missing, so no code can be verified. Fails closed. */
  | 'not_configured'
  /** Wrong shape — rejected without a query. */
  | 'malformed'
  /** No invite with that digest. */
  | 'unknown'
  | 'deactivated'
  | 'expired'
  | 'exhausted'

export type RedemptionResult =
  | { ok: true; inviteCodeId: string; codePrefix: string }
  | { ok: false; reason: RedemptionFailure }

/**
 * ONE MESSAGE FOR EVERY FAILURE.
 *
 * "That code does not exist", "that code is exhausted" and "that code expired"
 * are all reported identically. Distinguishing them turns the sign-up form into
 * an oracle for which invite codes are real — an attacker submitting candidates
 * would learn, from the wording alone, when they had found a genuine one that
 * merely happened to be used up. The internal reason is recorded in the audit
 * log, where it is useful and not reachable.
 */
export const GENERIC_INVITE_FAILURE =
  'That invite code is invalid or no longer available.'

/**
 * Claims one use of an invite, inside the caller's transaction.
 *
 * Returns the invite id on success so the caller can write the redemption row
 * against it. Does NOT write that row itself — the caller has the user id, and
 * splitting the write keeps this function to the one thing that has to be
 * atomic.
 */
export async function redeemInviteCodeWithin(
  tx: DbExecutor,
  rawCode: string,
): Promise<RedemptionResult> {
  if (!isInviteSystemConfigured()) return { ok: false, reason: 'not_configured' }

  /**
   * Shape-checked before hashing. Cheap, and it keeps obviously-junk input from
   * reaching the database at all — but it is never the authority on validity,
   * and a malformed code returns the same message to the customer as a real one
   * that is exhausted.
   */
  if (!looksLikeInviteCode(rawCode)) return { ok: false, reason: 'malformed' }

  const codeHash = hashInviteCode(rawCode)

  /**
   * THE ATOMIC CLAIM. Every usability condition lives in this WHERE clause, and
   * nowhere else. `use_count` is incremented from its own column value rather
   * than from a value read earlier, so there is no lost update.
   */
  const claimed = await tx
    .update(schema.inviteCodes)
    .set({ useCount: sql`${schema.inviteCodes.useCount} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(schema.inviteCodes.codeHash, codeHash),
        isNull(schema.inviteCodes.deactivatedAt),
        or(
          isNull(schema.inviteCodes.expiresAt),
          sql`${schema.inviteCodes.expiresAt} > now()`,
        ),
        lt(schema.inviteCodes.useCount, schema.inviteCodes.maxUses),
      ),
    )
    .returning({
      id: schema.inviteCodes.id,
      codePrefix: schema.inviteCodes.codePrefix,
    })

  const invite = claimed[0]
  if (invite) {
    return { ok: true, inviteCodeId: invite.id, codePrefix: invite.codePrefix }
  }

  /**
   * The claim failed. Classify WHY — for the audit log only.
   *
   * A second query, deliberately, and deliberately after the fact. Folding these
   * checks into the statement above would have meant reading the invite first,
   * which is the race this whole design exists to avoid. The classification is
   * advisory: by the time it runs the invite may have changed again, and that
   * does not matter, because nothing is decided here. The customer has already
   * been refused.
   */
  return { ok: false, reason: await classifyFailure(tx, codeHash) }
}

async function classifyFailure(
  tx: DbExecutor,
  codeHash: string,
): Promise<RedemptionFailure> {
  const [row] = await tx
    .select({
      deactivatedAt: schema.inviteCodes.deactivatedAt,
      expiresAt: schema.inviteCodes.expiresAt,
      useCount: schema.inviteCodes.useCount,
      maxUses: schema.inviteCodes.maxUses,
    })
    .from(schema.inviteCodes)
    .where(eq(schema.inviteCodes.codeHash, codeHash))
    .limit(1)

  if (!row) return 'unknown'
  if (row.deactivatedAt !== null) return 'deactivated'
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return 'expired'
  if (row.useCount >= row.maxUses) return 'exhausted'

  /**
   * The claim failed but every condition now reads as usable — which means
   * another transaction took the last use between the UPDATE and this SELECT.
   * From this customer's point of view that is exhaustion, and it is the honest
   * classification: the invite genuinely had no use left for them.
   */
  return 'exhausted'
}

/**
 * Records who used which invite. Called in the same transaction as the claim.
 *
 * Separate from the claim because the caller needs the user id, which does not
 * exist until the `users` INSERT has run — and that INSERT must be inside the
 * same transaction as the claim, not before it.
 */
export async function recordRedemptionWithin(
  tx: DbExecutor,
  inviteCodeId: string,
  userId: string,
): Promise<void> {
  await tx.insert(schema.inviteCodeRedemptions).values({ inviteCodeId, userId })
}

/**
 * Non-consuming existence probe, for the ADMIN side only.
 *
 * Never call this from the registration path. Checking an invite and then
 * redeeming it is exactly the read-then-write race described at the top of this
 * file, and this function exists solely so the admin panel can look up an
 * invite it already has the id of.
 */
export async function findInviteByCode(rawCode: string) {
  if (!isInviteSystemConfigured() || !looksLikeInviteCode(rawCode)) return null

  const [row] = await db
    .select()
    .from(schema.inviteCodes)
    .where(eq(schema.inviteCodes.codeHash, hashInviteCode(rawCode)))
    .limit(1)

  return row ?? null
}
