'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/auth/audit'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import {
  RATE_LIMITS,
  checkUserRateLimit,
  rateLimitMessage,
} from '@/lib/security/rate-limit'
import { fail, formDataToObject, ok, parseInput, type ActionResult } from '@/lib/result'
import { generateInviteCode, isInviteSystemConfigured, maskInviteCode } from './codes'

/**
 * Invite administration.
 *
 * BOTH ADMINISTRATORS MAY MANAGE INVITES. There is no security reason to reserve
 * this for the owner: an invite creates a customer account and nothing more, so
 * the worst a compromised backup administrator can do here is admit shoppers to
 * a private shop. That is a business problem, fully reversible by deactivating
 * the code, and every issuance is attributed. Reserving it for the owner would
 * make the backup slot useless for the job it exists to cover — someone minding
 * the store — without closing any real hole.
 *
 * The operations that ARE owner-only are the ones that change who can administer
 * the store, or that move money. Those live in `lib/admin/backup-admin.ts` and
 * `lib/payments/`.
 */

const createSchema = z.object({
  label: z
    .string()
    .trim()
    .max(120, 'Label is too long')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),

  /**
   * Bounded at both ends. A `max_uses` of zero would create a code that is born
   * exhausted, and an unbounded one turns a private storefront public the moment
   * it leaks — which is precisely the failure mode invites exist to prevent.
   */
  maxUses: z.coerce
    .number()
    .int('Enter a whole number')
    .min(1, 'An invite must allow at least one use')
    .max(500, 'Use 500 or fewer. For a larger campaign, issue several codes.'),

  /**
   * Optional expiry, as a date string from the form. Empty means never.
   */
  expiresAt: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value))
    .refine(
      (value) => value === undefined || !Number.isNaN(Date.parse(value)),
      'That is not a valid date',
    ),
})

const deactivateSchema = z.object({
  inviteId: z.uuid('Unknown invite'),
})

/**
 * Creates an invite and returns the raw code ONCE.
 *
 * THIS IS THE ONLY TIME THE CODE EXISTS OUTSIDE THE RECIPIENT'S HANDS. It is
 * returned in the action result, rendered by the page, and then it is gone —
 * there is no column holding it, no audit row containing it, and no function
 * anywhere in this codebase that can reconstruct it. An administrator who
 * navigates away before copying it must issue a replacement, and that is the
 * correct trade: a system that can show you the code again is a system where a
 * database dump hands over every outstanding invite.
 */
export async function createInviteAction(
  _previous: ActionResult<{ code: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ code: string }>> {
  const admin = await requireAdminIdentity()

  /**
   * Fails closed rather than issuing a code it cannot hash. Without the pepper
   * `hashInviteCode` throws, and a 500 here would be an administrator staring
   * at an error with no idea that one environment variable is missing.
   */
  if (!isInviteSystemConfigured()) {
    return fail(
      'internal_error',
      'Invite codes are not configured on this deployment. INVITE_CODE_PEPPER must be set.',
    )
  }

  const parsed = parseInput(createSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  /**
   * Blast-radius limit rather than an attack limit. An administrator whose
   * session has been taken over should not be able to mint hundreds of working
   * invites to a private storefront before anyone notices.
   */
  const throttle = await checkUserRateLimit({
    userId: admin.user.id,
    ...RATE_LIMITS.inviteCreation,
  })
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null

  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    return fail('validation_error', 'That expiry date is in the past.', {
      expiresAt: ['Choose a future date'],
    })
  }

  const generated = generateInviteCode()

  const [created] = await db
    .insert(schema.inviteCodes)
    .values({
      codeHash: generated.codeHash,
      codePrefix: generated.codePrefix,
      label: parsed.data.label ?? null,
      maxUses: parsed.data.maxUses,
      expiresAt,
      createdBy: admin.user.id,
    })
    .returning({ id: schema.inviteCodes.id })

  /**
   * The MASKED prefix, never the code. This rule holds for every audit row the
   * invite system writes — a log that contained working invites would be a
   * second, less protected copy of the thing the hashing exists to protect.
   */
  await recordAuditEvent({
    event: 'INVITE_CREATED',
    userId: admin.user.id,
    sessionId: admin.sessionId,
    entityType: 'invite_code',
    entityId: created.id,
    summary: `invite ${maskInviteCode(generated.codePrefix)} created — ${
      parsed.data.maxUses
    } use${parsed.data.maxUses === 1 ? '' : 's'}${
      parsed.data.label ? ` — ${parsed.data.label}` : ''
    }`,
  })

  revalidatePath('/admin/invites')

  return ok({ code: generated.code })
}

/**
 * Deactivates an invite.
 *
 * WHAT THIS DOES NOT DO, per section R: it does not delete accounts created
 * through the code, does not sign anyone out, does not erase redemption history,
 * and does not remove the audit trail. Somebody who legitimately joined last
 * month is still a customer. The only thing that changes is that the code stops
 * working for anyone new, immediately — the redemption UPDATE's WHERE clause
 * tests `deactivated_at is null`, so the next attempt matches zero rows.
 *
 * There is no reactivation. An invite an operator believed was dead must not be
 * able to come back to life; the replacement flow issues a fresh code instead.
 */
export async function deactivateInviteAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdminIdentity()

  const parsed = parseInput(deactivateSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  /**
   * Scoped by `deactivated_at IS NULL` as well as by id, so a double submission
   * cannot overwrite who deactivated it and when.
   */
  const [updated] = await db
    .update(schema.inviteCodes)
    .set(
      withUpdatedAt({
        deactivatedAt: new Date(),
        deactivatedBy: admin.user.id,
      }),
    )
    .where(
      and(
        eq(schema.inviteCodes.id, parsed.data.inviteId),
        isNull(schema.inviteCodes.deactivatedAt),
      ),
    )
    .returning({
      id: schema.inviteCodes.id,
      codePrefix: schema.inviteCodes.codePrefix,
    })

  if (!updated) {
    return fail('not_found', 'That invite is already deactivated, or does not exist.')
  }

  await recordAuditEvent({
    event: 'INVITE_DEACTIVATED',
    userId: admin.user.id,
    sessionId: admin.sessionId,
    entityType: 'invite_code',
    entityId: updated.id,
    summary: `invite ${maskInviteCode(updated.codePrefix)} deactivated`,
  })

  revalidatePath('/admin/invites')
  return ok()
}
