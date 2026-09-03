/**
 * Private-marketplace access — resolution only.
 *
 * NOT WIRED. Nothing in the running application calls this. `lib/auth/dal.ts`
 * binds it to a query and exposes a guard, and that guard has no call sites
 * either. Switching enforcement on is a separate, production-impacting step
 * that must not happen before the backfill described in
 * `lib/db/schema/marketplace.ts` has been run and its resulting population
 * inspected — the table is empty today, so an enforced gate would admit nobody.
 *
 * NO IMPORTS, DELIBERATELY. Not `server-only`, not the drizzle schema, not
 * `SessionUser`. This module is the one place the entry decision is made, and
 * keeping it dependency-free means it can be exercised in a plain process with
 * no database, no environment and no request scope — which is what makes the
 * checks in `scripts/verify-marketplace-access.ts` assertions about the real
 * decision function rather than about a stand-in for it.
 *
 * `users.role` AND `users.status` ARE NEVER READ HERE, AND CANNOT BE. The
 * resolver is not given a user at all; its only input is the membership row.
 * That is stronger than a promise not to look: there is nothing to look at.
 * Marketplace membership is a separate fact from what an account IS to the
 * storefront, and the moment one is derived from the other, every future change
 * to either silently changes the other too.
 *
 * VENDOR SCOPE DOES NOT AUTHORIZE SELLING. `scope = 'vendor'` grants entry to
 * the private marketplace and nothing more — see `authorizesSelling` below.
 *
 * SIDE-EFFECT FREE AND SYNCHRONOUS. No I/O, no audit writes, no `forbidden()`,
 * no redirects. The resolver reports what it found and the caller decides,
 * which is what lets a silent UI probe and an enforcing guard share one
 * decision without drifting into disagreeing about who is a member.
 */

/**
 * The scope vocabulary, mirroring the `marketplace_scope` pg enum.
 *
 * Restated rather than imported. The import would drag drizzle into a module
 * whose whole value is having no dependencies, and the two lists are held
 * together by an assertion in `scripts/verify-marketplace-access.ts` that
 * compares them value for value — so drift is a failing check rather than a
 * silent divergence.
 */
export const MARKETPLACE_SCOPES = ['shopper', 'vendor'] as const
export type MarketplaceScope = (typeof MARKETPLACE_SCOPES)[number]

/** Mirrors the `marketplace_access_status` pg enum. Same alignment check. */
export const MARKETPLACE_ACCESS_STATUSES = ['active', 'suspended', 'revoked'] as const
export type MarketplaceAccessStatus = (typeof MARKETPLACE_ACCESS_STATUSES)[number]

/**
 * The membership row, reduced to the two columns that decide entry.
 *
 * A full `marketplace_access` row is structurally assignable to this, so the
 * DAL can hand over what it selected without a conversion step. Nothing else on
 * the row participates in the decision.
 */
export type MarketplaceMembership = {
  scope: MarketplaceScope
  status: MarketplaceAccessStatus
}

/** Why entry was granted. One value today; named so denials and grants read alike. */
export type MarketplaceGrantReason = 'active_membership'

export type MarketplaceDenialReason =
  /** No signed-in user. Constructed by `deniedForAnonymous`, never resolved. */
  | 'not_signed_in'
  /** Signed in, but no `marketplace_access` row exists for the account. */
  | 'no_membership'
  /** A row exists and is `suspended` — reversible, but not entry today. */
  | 'membership_suspended'
  /** A row exists and is `revoked`. */
  | 'membership_revoked'
  /** The row carries a scope or status this build does not know. Fails closed. */
  | 'unrecognized_membership'

export type MarketplaceAccessGranted = {
  granted: true
  /** Entry scope. NOT a selling right — see `authorizesSelling`. */
  scope: MarketplaceScope
  reason: MarketplaceGrantReason
}

export type MarketplaceAccessDenied = {
  granted: false
  /** The scope on the row when one was found and understood, else null. */
  scope: MarketplaceScope | null
  reason: MarketplaceDenialReason
}

/**
 * Every decision carries a reason, including the successful one. A gate that
 * answers only yes or no leaves the caller — a support screen, an audit row, a
 * denial page — to guess between "never a member", "suspended" and "revoked",
 * which are three different conversations to have with the person locked out.
 */
export type MarketplaceAccessDecision = MarketplaceAccessGranted | MarketplaceAccessDenied

/** `value` if it is a scope this build understands, else null. */
function knownScope(value: string): MarketplaceScope | null {
  return (MARKETPLACE_SCOPES as readonly string[]).includes(value)
    ? (value as MarketplaceScope)
    : null
}

/** `value` if it is a status this build understands, else null. */
function knownStatus(value: string): MarketplaceAccessStatus | null {
  return (MARKETPLACE_ACCESS_STATUSES as readonly string[]).includes(value)
    ? (value as MarketplaceAccessStatus)
    : null
}

/**
 * The decision for a request with no signed-in user.
 *
 * Lives here rather than in the DAL so that every shape a
 * `MarketplaceAccessDecision` can take is built in one module. A caller that
 * assembles its own denial object is a caller that can invent a reason string
 * nothing else recognises, or — worse, one edit later — assemble a grant.
 *
 * Unreachable from `resolveMarketplaceAccess`, which is never told who is
 * asking. The two entry points are separate on purpose.
 */
export function deniedForAnonymous(): MarketplaceAccessDecision {
  return { granted: false, scope: null, reason: 'not_signed_in' }
}

/**
 * Does this membership row admit its holder to the private marketplace?
 *
 * `null` means the lookup found nothing, which is the ordinary state of every
 * account today and is a denial like any other.
 *
 * BOTH FIELDS ARE VALIDATED BEFORE EITHER IS TRUSTED, and the unknown case
 * denies. Postgres cannot remove an enum value but it can gain one, and a
 * deployment running older code against a newer database would otherwise reach
 * the grant with a value it has never heard of. `scope = 'vendor'` must not
 * become an administrator by way of some future third scope, so an
 * unrecognised row is refused rather than interpreted generously — the cost of
 * that is one member seeing a denial during a rollout, and the cost of the
 * other direction is admitting whoever the new value describes.
 *
 * ACTIVE IS THE ONLY STATUS THAT ADMITS. `suspended` and `revoked` are
 * enumerated explicitly so each produces its own reason; they are not folded
 * into a single "not active" branch, because reversibility is the difference
 * between them and the person on the other end deserves to be told which.
 */
export function resolveMarketplaceAccess(
  membership: MarketplaceMembership | null,
): MarketplaceAccessDecision {
  if (membership === null) {
    return { granted: false, scope: null, reason: 'no_membership' }
  }

  const scope = knownScope(membership.scope)
  const status = knownStatus(membership.status)

  if (scope === null || status === null) {
    return { granted: false, scope: null, reason: 'unrecognized_membership' }
  }

  switch (status) {
    case 'active':
      return { granted: true, scope, reason: 'active_membership' }
    case 'suspended':
      return { granted: false, scope, reason: 'membership_suspended' }
    case 'revoked':
      return { granted: false, scope, reason: 'membership_revoked' }
  }
}

/**
 * Does a marketplace decision authorize SELLING? No. Never. Not for a vendor.
 *
 * The return type is the literal `false`, not `boolean`, so this cannot be
 * changed into a conditional without the signature changing with it — a
 * reviewer sees the widening in the diff rather than having to notice a new
 * branch inside a body.
 *
 * WHY A FUNCTION THAT RETURNS A CONSTANT. `scope = 'vendor'` is the most
 * inviting wrong inference in this whole area: it reads like a seller flag, it
 * is the only other value the enum has, and a listing screen guarded by
 * "the decision is granted and the scope is vendor" would look entirely
 * reasonable in review. Selling rights depend on `vendors`,
 * `vendor_memberships` and compliance state, none of which exist yet and none
 * of which may be inferred from a marketplace-entry row. This exists so that
 * the code the next person reaches for says no in one line, instead of leaving
 * them to reconstruct the argument from a schema comment.
 *
 * The decision is accepted and deliberately unread — underscored per the
 * convention in `eslint.config.mjs` — so that the call site reads as a question
 * about that decision rather than as a bare constant.
 */
export function authorizesSelling(_decision: MarketplaceAccessDecision): false {
  return false
}
