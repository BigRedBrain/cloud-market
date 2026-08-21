import 'server-only'

import { serverEnv } from '@/lib/env'
import type { AuditEvent } from '@/lib/db/schema'
import type { SessionUser } from './session'

/**
 * Administrator identity — resolution only.
 *
 * NOT WIRED. Nothing calls this yet. `requireAdmin()` is still what protects
 * `/admin`, and swapping to it is a separate, production-impacting step.
 *
 * WHY THIS EXISTS
 *
 * Migration 0017 shipped a model this codebase never implemented: the OWNER is
 * an environment variable, and the single live `admin_backup` row is the only
 * other administrator. The database already enforces the ceiling — a partial
 * unique index over a CHECK-pinned constant column, plus a trigger holding an
 * advisory lock — but the application still grants admin from `users.role`,
 * which is a column any future write path could set.
 *
 * `users.role` IS NEVER READ HERE. That is the entire point: a table full of
 * accounts marked `admin` must still yield exactly zero administrators. The
 * type carries `SessionUser`, which has a `role` field on it, and this module
 * deliberately ignores it.
 *
 * THE TWO CLAIMS ARE INDEPENDENT
 *
 * Owner authorization and backup authorization are resolved separately, and a
 * broken `CLOUDMARKET_OWNER_USER_ID` disables ONLY the first. An earlier draft
 * of this file returned as soon as the owner variable failed to parse, which
 * looked like failing closed and was actually a self-inflicted outage: a typo
 * in one environment variable would have locked out the backup administrator
 * too, leaving nobody able to reach /admin and no in-product way to fix it.
 * The backup slot exists precisely so that losing the owner is survivable, and
 * it can only do that job if it is reachable when the owner is not.
 *
 * So a bad owner variable makes the platform *degraded*, not *dead*: owner
 * authorization is unavailable, the backup still works, and the resolution
 * carries the configuration state so the enforcing guard can record the
 * misconfiguration while still admitting the legitimate backup.
 *
 * SIDE-EFFECT FREE. No audit writes, no `forbidden()`, no redirects. The
 * resolver reports what it found and the caller decides — which is what lets
 * `getAdminIdentity()` stay silent for UI probing while
 * `requireAdminIdentity()` audits and denies, without the two drifting apart.
 *
 * The backup lookup is injected rather than performed here so this logic can be
 * tested without a database. `lib/auth/dal.ts` binds the real query.
 */

export type AdminIdentity =
  | { kind: 'owner'; user: SessionUser }
  | { kind: 'backup'; user: SessionUser }

/**
 * Health of `CLOUDMARKET_OWNER_USER_ID`, reported independently of whether
 * anyone was authorized.
 *
 * Present on BOTH arms of the resolution, and that is the whole fix: an
 * authorized backup administrator working through a broken owner variable is a
 * situation somebody needs to be told about, and a type that could only report
 * configuration problems alongside a denial had no way to say it.
 */
export type OwnerConfigState = 'ok' | 'owner_not_configured' | 'owner_malformed'

/** The two states in which owner authorization cannot be offered at all. */
export type OwnerConfigFault = Exclude<OwnerConfigState, 'ok'>

/** Why a resolution came back unauthorized. Drives the audit event. */
export type AdminIdentityFailure = OwnerConfigFault | 'not_signed_in' | 'not_an_administrator'

export type AdminIdentityResolution =
  | {
      status: 'authorized'
      identity: AdminIdentity
      /** May be a fault even here — see `OwnerConfigState`. */
      ownerConfig: OwnerConfigState
    }
  | {
      status: 'unauthorized'
      ownerConfig: OwnerConfigState
      /** The signed-in user, when there is one. For audit attribution. */
      user: SessionUser | null
      detail: AdminIdentityFailure
    }

export type OwnerIdResult =
  | { ok: true; userId: string }
  | { ok: false; reason: OwnerConfigFault }

/** Any RFC 4122 layout. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shape check only — deliberately not version- or variant-strict.
 *
 * The job is to catch a misconfiguration (an email, a truncated paste, a
 * placeholder) and turn it into a legible failure. Pinning the version digit
 * would risk rejecting a legitimate production id for no security gain, and the
 * consequence of that is an admin lockout.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * Lower-case form, which is the only form Postgres ever renders a `uuid` in.
 *
 * `isUuid` accepts `A-F` because RFC 4122 does, and a person copying an id out
 * of a spreadsheet or a support ticket may well bring uppercase with them. But
 * `SessionUser.id` comes straight out of a `uuid` column, so it is always
 * lower-case — comparing the two as raw strings would reject a correctly
 * configured owner purely on letter case. Canonicalising both sides removes an
 * entire class of "the value is right and it still doesn't work" lockout, and
 * cannot cause a false match: two distinct rows cannot differ only by case.
 */
function canonicalUuid(value: string): string {
  return value.toLowerCase()
}

/**
 * Read and validate `CLOUDMARKET_OWNER_USER_ID`, returning it canonicalised.
 *
 * Declared optional in `lib/env.ts` and validated here, matching how
 * `CRON_SECRET` is handled: a malformed value must not stop the storefront
 * booting, it must fail closed at the boundary that cares and say so.
 *
 * Trimmed before validation because an id pasted into a dashboard field
 * routinely arrives with a trailing newline, and an owner locked out by
 * invisible whitespace is a genuinely unpleasant thing to diagnose.
 */
export function readConfiguredOwnerId(): OwnerIdResult {
  const configured = serverEnv().CLOUDMARKET_OWNER_USER_ID?.trim()

  if (!configured) return { ok: false, reason: 'owner_not_configured' }
  if (!isUuid(configured)) return { ok: false, reason: 'owner_malformed' }

  return { ok: true, userId: canonicalUuid(configured) }
}

/** Returns the live backup's user id, or null when the slot is empty. */
export type BackupLookup = () => Promise<string | null>

/**
 * The shared resolver. Both `getAdminIdentity()` and `requireAdminIdentity()`
 * go through this, so they cannot disagree about who is an administrator.
 *
 * The owner variable is READ before any of the checks below, because
 * `ownerConfig` is attached to every arm of the result including the anonymous
 * one — a configuration health check should not need someone to be signed in
 * before it can see a fault. Reading it early is free and safe: it is a pure
 * environment read with no I/O and no side effect, so an anonymous request pays
 * nothing for it and nothing observable happens as a result of it.
 *
 * ORDER MATTERS FOR THE DECISIONS, and each step is deliberate:
 *
 *  1. No session decides first. An anonymous request is not an admin-access
 *     event, so it is reported as `not_signed_in` whatever state the owner
 *     variable is in — a drive-by can never surface as a configuration
 *     incident, even though the fault still rides along on `ownerConfig` for
 *     anything that wants it. No lookup either: there is nobody to match
 *     against.
 *  2. Owner match second, and it SHORT-CIRCUITS. When the signed-in user is the
 *     configured owner, `lookupLiveBackupUserId` is never called: the owner
 *     claim is anchored in the environment, it outranks the backup slot, and
 *     querying for a row that cannot change the answer is wasted work. This is
 *     also what makes owner-precedence structural rather than a tie-break
 *     applied afterwards, including when owner and backup are the same account.
 *  3. Backup third, and REACHED REGARDLESS OF OWNER CONFIGURATION. This is the
 *     step the earlier draft skipped when the owner variable was unusable. The
 *     backup slot is a row in the database and an environment variable cannot
 *     invalidate it; gating it on the owner parsing correctly coupled two
 *     independent facts and turned a one-character typo into a total lockout.
 *  4. Denial last, naming the configuration fault when there is one, because
 *     "the owner variable is broken AND you are not the backup" is a different
 *     thing for an operator to read than "you are not an administrator".
 */
export async function resolveAdminIdentity(
  user: SessionUser | null,
  lookupLiveBackupUserId: BackupLookup,
): Promise<AdminIdentityResolution> {
  const owner = readConfiguredOwnerId()
  const ownerConfig: OwnerConfigState = owner.ok ? 'ok' : owner.reason

  if (!user) {
    return {
      status: 'unauthorized',
      ownerConfig,
      user: null,
      detail: 'not_signed_in',
    }
  }

  const userId = canonicalUuid(user.id)

  if (owner.ok && userId === owner.userId) {
    return { status: 'authorized', identity: { kind: 'owner', user }, ownerConfig }
  }

  const backupUserId = await lookupLiveBackupUserId()
  if (backupUserId !== null && canonicalUuid(backupUserId) === userId) {
    return { status: 'authorized', identity: { kind: 'backup', user }, ownerConfig }
  }

  return {
    status: 'unauthorized',
    ownerConfig,
    user,
    /*
     * A broken owner variable is the more actionable of the two facts, so it
     * wins the label. `not_an_administrator` is reserved for the ordinary case
     * where the platform is configured correctly and this person simply is not
     * an administrator — which is the one worth alerting on.
     */
    detail: owner.ok ? 'not_an_administrator' : owner.reason,
  }
}

/**
 * Which audit event a failure deserves, or null for the ones that deserve none.
 *
 * Pure and exported so the mapping is testable. Living in `dal.ts` it would be
 * unreachable without a database, and this is precisely the decision worth
 * pinning down: a misconfiguration and an unauthorised attempt are different
 * incidents, and an anonymous request is neither.
 *
 * FUTURE CUTOVER HOOK — do not implement in this batch. Once
 * `requireAdminIdentity()` actually guards `/admin`, every denied hit writes an
 * `ADMIN_ACCESS_DENIED` row, and a crawler or scanner can flood `audit_log`
 * through it. Throttling or de-duplicating those writes needs a TRUSTED origin
 * source — a client-supplied header is forgeable and would let an attacker
 * either evade the limit or poison someone else's. `lib/security/rate-limit.ts`
 * exists and is unwired; wiring it is part of the cutover, not of this.
 */
export function auditEventForFailure(
  detail: AdminIdentityFailure,
): AuditEvent | null {
  switch (detail) {
    case 'owner_not_configured':
    case 'owner_malformed':
      return 'OWNER_IDENTITY_MISCONFIGURED'
    case 'not_an_administrator':
      return 'ADMIN_ACCESS_DENIED'
    case 'not_signed_in':
      return null
  }
}

/**
 * The configuration event for an owner-variable state, independent of whether
 * anyone was authorized.
 *
 * Exists so the guard can record a misconfiguration on a resolution that
 * SUCCEEDED — an authorized backup administrator carrying a broken owner
 * variable. There is no other signal that this has happened, and it is exactly
 * the state where the platform is one incident away from having no
 * administrators at all.
 */
export function auditEventForOwnerConfig(
  state: OwnerConfigState,
): AuditEvent | null {
  return state === 'ok' ? null : auditEventForFailure(state)
}
