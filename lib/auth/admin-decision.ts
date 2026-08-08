/**
 * The administrative access decision, isolated as a pure function.
 *
 * NO IMPORTS. Not `server-only`, not `next/navigation`, not the database, not
 * even the session types. That is the entire reason this file exists as
 * something separate from `admin-identity.ts`.
 *
 * WHY IT WAS SPLIT OUT
 *
 * The decision started life inside `resolveAdminIdentity`, which imports
 * `next/navigation` for `forbidden()`. That single import drags in React's
 * client-side router context, so anything importing the module outside a
 * rendering runtime dies with `React.createContext is not a function` — and the
 * most security-critical judgement in this application was therefore reachable
 * only through an end-to-end test against a running server.
 *
 * That is the wrong place to prove "a customer holding every named permission
 * still gets nothing". A claim like that deserves an exhaustive table across
 * every combination of role, status, ownership and slot state, and a table like
 * that needs a function you can simply call.
 *
 * So the I/O and the control-flow interrupts stay in `admin-identity.ts`, and
 * the judgement lives here, taking the facts it needs as plain arguments.
 * `scripts/verify-phase-5-authz.mts` drives it across the full cross-product.
 *
 * NOTE WHAT IS ABSENT FROM THE SIGNATURE: there is no parameter for named
 * permissions, and there cannot be one. `compliance_admin`,
 * `catalog_compliance_admin` and anything added later are incapable of
 * influencing this decision because they are not inputs to it. That is a
 * stronger guarantee than checking them and then ignoring them — it is enforced
 * by the type system rather than by a reviewer noticing.
 */

/** Rank within the closed admin set. */
export type AdminRank = 'owner' | 'backup'

/** Why a caller was refused. Used for audit; never rendered verbatim. */
export type AdminDenialReason =
  | 'no_session'
  | 'owner_env_missing'
  | 'owner_env_malformed'
  | 'account_inactive'
  | 'role_not_admin'
  | 'not_owner_or_backup'

/**
 * The strict-parsed owner id, or the reason it is unusable.
 *
 * Structurally identical to `resolveOwnerUserId`'s return type, declared here so
 * this module needs no import to describe its own input.
 */
export type OwnerResolution =
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'owner_env_missing' | 'owner_env_malformed' }

/** The minimum this decision needs to know about the caller. */
export type AdminCandidate = {
  id: string
  role: string
  status: string
}

export type AdminVerdict =
  | { ok: true; rank: AdminRank }
  | { ok: false; reason: AdminDenialReason }

/**
 * Decides whether this account may administer CloudMarket.
 *
 * The checks run in the order section D specifies, and the order matters:
 * identity is established before any capability is consulted, so there is no
 * code path in which a permission grant is read before we know whether the
 * caller is allowed to be here at all.
 *
 * FAILS CLOSED on a missing or malformed owner id — including for the real
 * owner and a legitimately assigned backup. The alternative, falling back to a
 * role check, would mean a deployment that forgot one environment variable
 * silently downgrades to the weaker model this replaced, which is the worst
 * possible failure mode: invisible, and only discovered afterwards.
 */
export function decideAdminAccess(input: {
  user: AdminCandidate
  owner: OwnerResolution
  /** The live backup-slot occupant, or null when the slot is empty. */
  backupUserId: string | null
}): AdminVerdict {
  const { user, owner, backupUserId } = input

  /* 1. The account must be usable. */
  if (user.status !== 'active') return { ok: false, reason: 'account_inactive' }

  /**
   * 2. The role. NECESSARY BUT NOT SUFFICIENT.
   *
   * A role is a column, and columns get written — by a future admin screen, a
   * repair script, a migration, or a session belonging to somebody who already
   * had some write access. If this were the last check, every one of those paths
   * would be a privilege escalation. It is here to catch inconsistent state, not
   * to grant anything.
   */
  if (user.role !== 'admin') return { ok: false, reason: 'role_not_admin' }

  /* 3. Identity. This is the check that actually decides. */
  if (!owner.ok) return { ok: false, reason: owner.reason }

  if (user.id === owner.ownerId) return { ok: true, rank: 'owner' }

  if (backupUserId !== null && user.id === backupUserId) {
    return { ok: true, rank: 'backup' }
  }

  return { ok: false, reason: 'not_owner_or_backup' }
}
