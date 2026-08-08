/**
 * Derived invite status.
 *
 * There is no `status` column on `invite_codes`, on purpose. These four values
 * are functions of four facts the redemption path already checks — deactivation,
 * expiry, budget and usage — and storing a fifth fact that has to be kept in
 * step with them is how a UI ends up saying ACTIVE about an invite the server
 * refuses, or EXHAUSTED about one it happily accepts.
 *
 * A plain module with no imports, so the admin table and the test suite can both
 * use it and assert they agree.
 */

export type InviteStatus = 'active' | 'exhausted' | 'expired' | 'deactivated'

export type InviteStatusInput = {
  deactivatedAt: Date | null
  expiresAt: Date | null
  useCount: number
  maxUses: number
}

/**
 * ORDER MATTERS, and it is the order an operator would explain it in.
 *
 * Deactivation is checked first because it is the deliberate act — an invite
 * someone switched off should read DEACTIVATED even if it also happens to have
 * expired, since that is the fact that answers "why did this stop working".
 * Expiry outranks exhaustion for the same reason: a code that ran out of time
 * before it ran out of uses expired.
 */
export function inviteStatus(
  invite: InviteStatusInput,
  now: Date = new Date(),
): InviteStatus {
  if (invite.deactivatedAt !== null) return 'deactivated'
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) {
    return 'expired'
  }
  if (invite.useCount >= invite.maxUses) return 'exhausted'
  return 'active'
}

/**
 * Would this invite be accepted right now?
 *
 * A CONVENIENCE FOR DISPLAY, NOT AN AUTHORISATION CHECK. The authoritative
 * condition is the WHERE clause of the conditional UPDATE in
 * `redeemInviteCode`, which evaluates it inside the same statement that
 * increments the counter. Anything computed out here is already stale by the
 * time it is read.
 */
export function isRedeemable(invite: InviteStatusInput, now: Date = new Date()): boolean {
  return inviteStatus(invite, now) === 'active'
}

/** Label for the admin table. */
export function inviteStatusLabel(status: InviteStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'exhausted':
      return 'Exhausted'
    case 'expired':
      return 'Expired'
    case 'deactivated':
      return 'Deactivated'
  }
}
