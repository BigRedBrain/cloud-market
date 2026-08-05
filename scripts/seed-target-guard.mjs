/**
 * Target classification for the development/staging limit seeder.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 *
 * Publishing a purchase limit rule is IRREVERSIBLE. The row cannot be edited or
 * deleted — that is the whole design — so a wrong value written to production
 * stays on the record forever and can only be corrected by publishing another.
 *
 * The production path for that write is `/admin/purchase-limits`, which
 * requires the named `compliance_admin` grant, step-up re-authentication, a
 * typed confirmation, an explicit acknowledgement, a written reason, and an
 * audit row committed in the same transaction as the rule.
 *
 * The seed script has none of those. It is a convenience for getting a fresh
 * development database into a usable state, and every one of those six controls
 * is absent from it. Documentation saying "do not run this against production"
 * is not a control; it is a hope. This is the control.
 *
 * Kept separate from the script so the verification suite can exercise the
 * exact function the CLI calls, including for a production fingerprint that
 * cannot be produced from a real connection string in a test.
 */
import { createHash } from 'node:crypto'

/**
 * Known production fingerprints.
 *
 * ONE ENTRY, because one is all that is actually known. `2b968b3cbe06` is
 * cloudmarket.cc production under the full-hostname scheme — the value every
 * verification suite in this repository already refuses on, and the value
 * `/api/health` publishes.
 *
 * The endpoint-id scheme (hostname's first label, `-pooler` stripped) produces
 * a different digest for the same database, and production's is **not known
 * here**. Rather than invent one, the caller supplies `PRODUCTION_POOLED_URL`
 * when it has it — the same variable the migration runbook already requires —
 * and both of its schemes are added to the denylist for that run. See
 * `denyFingerprintsFor`.
 *
 * Fingerprints, never hostnames: this file is committed, and a truncated digest
 * identifies a database to someone who already knows it without handing a
 * target to someone who does not.
 */
export const KNOWN_PRODUCTION_FINGERPRINTS = Object.freeze(['2b968b3cbe06'])

/**
 * The denylist for one run: the compiled-in value, plus both schemes of
 * `PRODUCTION_POOLED_URL` when the operator has it set.
 *
 * This is additive only. A missing `PRODUCTION_POOLED_URL` cannot weaken the
 * guard — it just means the run relies on the compiled-in value and the
 * positive declaration, both of which still have to pass.
 */
export function denyFingerprintsFor(productionPooledUrl) {
  const deny = [...KNOWN_PRODUCTION_FINGERPRINTS]
  if (!productionPooledUrl) return deny
  try {
    deny.push(hostFingerprint(productionPooledUrl), endpointFingerprint(productionPooledUrl))
  } catch {
    /** An unparseable value adds nothing; it must not remove anything either. */
  }
  return deny
}

/** The environments this script may write to. There is no third value. */
export const PERMITTED_ENVIRONMENTS = Object.freeze(['development', 'staging'])

export const hostFingerprint = (connectionString) =>
  createHash('sha256').update(new URL(connectionString).hostname).digest('hex').slice(0, 12)

export const endpointFingerprint = (connectionString) =>
  createHash('sha256')
    .update(new URL(connectionString).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

/**
 * Decides whether this target may be written to.
 *
 * FAIL CLOSED. The only way to get `{ allowed: true }` is to positively satisfy
 * every gate. Anything missing, unrecognised, contradictory or production is a
 * refusal — there is no path through this function that treats an unknown
 * target as safe.
 *
 * Pure: no I/O, no database connection, no environment reads of its own. The
 * caller passes what it observed, which is what lets the suite test a
 * production fingerprint without possessing a production connection string.
 */
export function classifyTarget({
  hostFp,
  endpointFp,
  declaredEnvironment,
  vercelEnv,
  nodeEnv,
  denyFingerprints = KNOWN_PRODUCTION_FINGERPRINTS,
}) {
  /**
   * 1. The unconditional refusal, FIRST.
   *
   * A known production fingerprint is refused before anything else is even
   * considered — before the declaration, before the flags, before the argument
   * parsing has any say. There is no combination of arguments, environment
   * variables or declarations that reaches past this branch, which is what
   * "unconditionally" has to mean to be worth writing down.
   */
  for (const fp of [hostFp, endpointFp]) {
    if (fp && denyFingerprints.includes(fp)) {
      return {
        allowed: false,
        reason: 'production_fingerprint',
        detail: `the target fingerprint ${fp} is a known production database`,
      }
    }
  }

  /**
   * 2. A platform that says it is production overrides any declaration.
   *
   * Someone running this inside a production deployment has almost certainly
   * inherited that deployment's connection string, whatever they typed.
   */
  if (vercelEnv === 'production' || nodeEnv === 'production') {
    return {
      allowed: false,
      reason: 'production_environment',
      detail: `the process reports a production environment (VERCEL_ENV=${vercelEnv ?? 'unset'}, NODE_ENV=${nodeEnv ?? 'unset'})`,
    }
  }

  /**
   * 3. The positive declaration.
   *
   * Absent, empty, misspelled or anything outside the permitted list is a
   * refusal — an unknown environment is an ambiguous one, and ambiguity here
   * resolves to "no". Note there is deliberately NO value that means
   * production: the declaration cannot be used to authorise the thing gate 1
   * exists to prevent, which is why it is not an `--allow-production` flag
   * wearing a different name.
   */
  const declared = (declaredEnvironment ?? '').trim()

  if (declared === '') {
    return {
      allowed: false,
      reason: 'environment_undeclared',
      detail: 'SEED_TARGET_ENVIRONMENT is not set',
    }
  }

  if (!PERMITTED_ENVIRONMENTS.includes(declared)) {
    return {
      allowed: false,
      reason: 'environment_not_permitted',
      detail: `SEED_TARGET_ENVIRONMENT="${declared}" is not one of ${PERMITTED_ENVIRONMENTS.join(', ')}`,
    }
  }

  /** 4. Both fingerprints must have been computable. */
  if (!hostFp || !endpointFp) {
    return {
      allowed: false,
      reason: 'target_unreadable',
      detail: 'the connection string could not be fingerprinted',
    }
  }

  return { allowed: true, environment: declared }
}

/** Operator-facing explanation. Never contains a credential or a hostname. */
export function describeRefusal(result) {
  const lines = [`REFUSING TO WRITE — ${result.detail}.`, '']

  switch (result.reason) {
    case 'production_fingerprint':
    case 'production_environment':
      lines.push(
        'Production purchase-limit rules are published ONLY through',
        '/admin/purchase-limits, which requires the compliance_admin grant,',
        'step-up re-authentication, a typed confirmation, a written reason and',
        'a transactionally committed audit row. This script has none of those,',
        'and publishing a rule cannot be undone.',
        '',
        'There is no flag that overrides this refusal.',
      )
      break
    case 'environment_undeclared':
    case 'environment_not_permitted':
      lines.push(
        'Declare the target explicitly before running this:',
        '',
        '  $env:SEED_TARGET_ENVIRONMENT = "development"   # or "staging"',
        '',
        'An unknown or ambiguous environment is refused. There is no value',
        'that authorises production — see /admin/purchase-limits for that.',
      )
      break
    case 'target_unreadable':
      lines.push('Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to a valid connection string.')
      break
  }

  return lines.join('\n')
}
