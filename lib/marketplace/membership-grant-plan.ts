/**
 * Marketplace membership grants — MANIFEST VALIDATION AND PLANNING ONLY.
 *
 * THIS MODULE CANNOT GRANT ANYTHING. It reads a manifest an operator wrote by
 * hand, reads a snapshot of what the database already says, and reports what a
 * separately reviewed future step *would* have to do. It holds no database
 * handle, performs no I/O, and every exported function is synchronous and
 * total — there is no code path here that reaches a connection, because there
 * is nothing here to reach one with.
 *
 * NO IMPORTS, DELIBERATELY — the same rule `lib/marketplace/access.ts` follows,
 * for the same reason. A module with no dependencies can be exercised in a bare
 * Node process with no environment, no request scope and no database, which is
 * what makes `scripts/verify-marketplace-membership-plan.ts` a set of
 * assertions about the real planner rather than about a stand-in. It also means
 * a mutation primitive cannot arrive here by accident: importing one would be
 * the first import in the file.
 *
 * THE VOCABULARIES ARE RESTATED, NOT IMPORTED. `marketplace_scope` and
 * `marketplace_access_status` are mirrored below rather than pulled from the
 * drizzle schema (which would drag drizzle in) or from `./access` (whose value
 * surface is deliberately audited by `scripts/verify-marketplace-access.ts` and
 * should stay as small as it is). Drift is a failing assertion in the verifier,
 * which compares these lists value for value against the pg enums.
 *
 * IDENTITY IS `users.id`, AND ONLY `users.id`. That is the immutable internal
 * primary key (`uuid`, `primaryKeyColumn()` in `lib/db/schema/_shared.ts`) and
 * it is exactly what `marketplace_access.user_id` references under the unique
 * index `marketplace_access_user_unique`. An email address is NOT identity here
 * — `expectedEmail` is operator verification metadata, a second opinion that
 * can only ever *block* a plan, never select or authorize a different account.
 *
 * MEMBERSHIP IS NEVER INFERRED. The planner is handed a membership row or
 * `null`; it is never handed a role, a status, an owner id, an order, a store
 * or anything else that could be read as "this person is probably a member".
 * `AccountSnapshot` has no field to smuggle one in through.
 *
 * VENDOR SCOPE IS MARKETPLACE ENTRY, NOT SELLING. Planning `scope = 'vendor'`
 * plans entry to the private marketplace and nothing else — see
 * `authorizesSelling()` in `./access`, which returns the literal `false`.
 *
 * TWO DECISIONS THAT LOOK LIKE PLUMBING LIVE HERE ON PURPOSE.
 * `checkManifestLocation()` decides whether a path is inside the repository, and
 * `verifyIdentities()` decides which accounts a membership read is allowed to
 * name. Neither touches a disk or a connection: one is string arithmetic over
 * path segments the caller already resolved, the other is map arithmetic over
 * rows the caller already fetched. They are RULES, and the rules belong beside
 * the rest of the policy where the verifier can exercise the real thing with
 * fixtures. The CLI performs the I/O and asks these functions what it is allowed
 * to do next; it does not decide for itself.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** The only manifest version this build understands. Exact, not a minimum. */
export const MEMBERSHIP_GRANT_MANIFEST_VERSION = 1

/**
 * The hard ceiling on one manifest.
 *
 * A grant list is meant to be read line by line by a human before it is
 * approved, and a review that cannot fit on a screen is a review that does not
 * happen. Twenty-five is small enough to read and large enough for a
 * grandfathering batch; a bigger population is several reviewed manifests, not
 * one unreviewable one. Enforced in `parseGrantManifest()` and again in
 * `planMembershipGrants()`, so a hand-built manifest cannot walk around it.
 */
export const MAX_MANIFEST_GRANTS = 25

/** Mirrors the `marketplace_scope` pg enum. Pinned by the verifier. */
export const GRANT_SCOPES = ['shopper', 'vendor'] as const
export type GrantScope = (typeof GRANT_SCOPES)[number]

/** Mirrors the `marketplace_access_status` pg enum. Pinned by the verifier. */
export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'revoked'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/**
 * Canonical 8-4-4-4-12 hexadecimal, matched case-insensitively.
 *
 * `users.id` is a Postgres `uuid`, which accepts several input spellings and
 * stores one. Braced, URN-prefixed and dash-free forms are refused rather than
 * canonicalised: the manifest is copied from an admin screen by a person, and
 * an id that does not look like the id they were shown is worth a second look
 * rather than a silent repair. Case IS repaired — Postgres renders `uuid` in
 * lower case, so an upper-case paste means the same row and must not be able to
 * hide beside its own lower-case twin in the duplicate check.
 */
export const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shape check for the optional verification address.
 *
 * Deliberately weak. This value never selects an account and never authorizes
 * one; it exists so a mistyped id fails loudly instead of granting entry to
 * whoever happens to own it. A strict deliverability grammar here would reject
 * legitimate addresses and buy nothing, because the only comparison it feeds is
 * an equality test against a value already stored.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

/** `users.email` is `varchar(255)`; anything longer cannot be a stored address. */
const EMAIL_MAX_LENGTH = 255

/**
 * The email comparison policy, stated once.
 *
 * TRIM THEN LOWER-CASE, then compare for exact equality — the same two steps
 * the shared `email` schema in `lib/auth/validation.ts` applies before any
 * address reaches the `users_email_unique` index, so a stored address and a
 * manifest address are normalised identically. Restated here rather than
 * imported because that module pulls in zod (and `next` types) and this one
 * takes no dependencies; the verifier asserts that `lib/auth/validation.ts`
 * still performs exactly these two steps, so a change to the repository policy
 * fails a check instead of silently diverging.
 *
 * NOTHING ELSE IS NORMALISED. No dot-stripping, no `+tag` removal, no unicode
 * folding: those are provider-specific conventions, and treating two distinct
 * stored addresses as equal is precisely the mistake that would let a
 * verification step wave through the wrong account.
 */
export function normalizeEmailForComparison(value: string): string {
  return value.trim().toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* Where a manifest is allowed to live                                         */
/* -------------------------------------------------------------------------- */

/**
 * A manifest names real accounts and real addresses, so it is an input from
 * OUTSIDE the repository — and that is now a runtime invariant rather than a
 * sentence in a usage message. This is the rule; the CLI supplies the two paths
 * and refuses to read the file when the rule says no.
 */
export const MANIFEST_LOCATION_VERDICTS = [
  /** Physically outside the repository. The only verdict that may proceed. */
  'outside_repository',
  /** The path IS the repository root. */
  'is_repository_root',
  /** The path is somewhere beneath the repository root. */
  'inside_repository',
  /** Not an absolute, normalised path — refused rather than guessed at. */
  'unusable_path',
] as const

export type ManifestLocationVerdict = (typeof MANIFEST_LOCATION_VERDICTS)[number]

export type ManifestLocationCheck = {
  verdict: ManifestLocationVerdict
  /**
   * Which of the two paths decided the verdict: the one the operator typed, or
   * the one it turned out to be after links were followed. `null` when the
   * manifest may proceed, or when the repository root itself is unusable.
   */
  offending: 'declared' | 'resolved' | 'repositoryRoot' | null
}

/**
 * A path split into comparable segments.
 *
 * Both separators are accepted because Windows tolerates both and an operator
 * can type either. The first element is kept verbatim — it is `''` for a
 * POSIX-absolute or UNC path and `'C:'` for a drive-qualified one — so that a
 * drive letter cannot silently compare equal to a root directory. Empty and `.`
 * segments elsewhere are dropped; `..` is NOT, because a surviving `..` means
 * the caller handed over something it had not normalised, and quietly folding it
 * here is how a boundary check ends up agreeing with the wrong file.
 */
function pathSegments(value: string): readonly string[] {
  const parts = value.split(/[\\/]+/)
  const segments: string[] = []

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (index === 0) {
      segments.push(part)
      continue
    }
    if (part.length === 0 || part === '.') continue
    segments.push(part)
  }

  return segments
}

/** Absolute, and free of anything this comparison cannot reason about. */
function isComparablePath(segments: readonly string[]): boolean {
  const head = segments[0]
  if (head === undefined) return false
  if (head.length !== 0 && !/^[a-z]:$/i.test(head)) return false
  return !segments.includes('..')
}

/**
 * Containment by SEGMENT, never by string prefix.
 *
 * `/srv/cloudmarket-notes` starts with `/srv/cloudmarket` and is a different
 * directory; a `startsWith` check calls it contained and refuses a perfectly
 * legitimate manifest, and the same mistake in the other direction is how a
 * sibling directory gets treated as part of the tree it merely resembles.
 *
 * `caseInsensitive` is the CALLER's statement about the filesystem, not a guess
 * made here — the planner cannot see `process.platform` and should not want to.
 */
export function isPathAtOrBeneath(
  directory: string,
  candidate: string,
  caseInsensitive: boolean,
): boolean {
  const root = pathSegments(directory)
  const target = pathSegments(candidate)

  if (!isComparablePath(root) || !isComparablePath(target)) return true
  if (target.length < root.length) return false

  for (let index = 0; index < root.length; index += 1) {
    const left = caseInsensitive ? root[index].toLowerCase() : root[index]
    const right = caseInsensitive ? target[index].toLowerCase() : target[index]
    if (left !== right) return false
  }

  return true
}

/**
 * Both the path the operator typed and the path it really is must be outside.
 *
 * TWO PATHS, BECAUSE ONE IS NOT ENOUGH. The lexical path catches the ordinary
 * mistake — a manifest committed next to the code. The link-resolved path
 * catches the interesting one: a file that sits outside by name and inside in
 * fact, whether the link is the manifest itself or any directory above it.
 * Either being inside is a refusal, so neither spelling of the same file can be
 * the one that gets through.
 *
 * FAIL CLOSED. A path this function cannot compare — relative, or still
 * carrying `..` — is `unusable_path` and refused, not assumed to be outside.
 */
export function checkManifestLocation(input: {
  repositoryRoot: string
  declaredPath: string
  resolvedPath: string
  caseInsensitive: boolean
}): ManifestLocationCheck {
  if (!isComparablePath(pathSegments(input.repositoryRoot))) {
    return { verdict: 'unusable_path', offending: 'repositoryRoot' }
  }

  const candidates = [
    ['declared', input.declaredPath],
    ['resolved', input.resolvedPath],
  ] as const

  for (const [label, candidate] of candidates) {
    const segments = pathSegments(candidate)

    if (!isComparablePath(segments)) return { verdict: 'unusable_path', offending: label }
    if (!isPathAtOrBeneath(input.repositoryRoot, candidate, input.caseInsensitive)) continue

    return {
      verdict:
        segments.length === pathSegments(input.repositoryRoot).length
          ? 'is_repository_root'
          : 'inside_repository',
      offending: label,
    }
  }

  return { verdict: 'outside_repository', offending: null }
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One validated request, with `userId` lower-cased and `expectedEmail`
 * normalised. `expectedEmail` is `null` when the operator supplied none.
 */
export type GrantRequest = {
  userId: string
  scope: GrantScope
  expectedEmail: string | null
}

export type GrantManifest = {
  version: typeof MEMBERSHIP_GRANT_MANIFEST_VERSION
  grants: readonly GrantRequest[]
}

export type ManifestIssueCode =
  | 'not_an_object'
  | 'unknown_field'
  | 'unsupported_version'
  | 'grants_not_an_array'
  | 'too_many_grants'
  | 'entry_not_an_object'
  | 'missing_user_id'
  | 'blank_user_id'
  | 'malformed_user_id'
  | 'duplicate_user_id'
  | 'missing_scope'
  | 'unknown_scope'
  | 'malformed_expected_email'

/** `path` is a JSON pointer-ish location, so an operator can find the line. */
export type ManifestIssue = {
  path: string
  code: ManifestIssueCode
  message: string
}

export type ManifestParseResult =
  | { ok: true; manifest: GrantManifest }
  | { ok: false; issues: readonly ManifestIssue[] }

const TOP_LEVEL_FIELDS: readonly string[] = ['version', 'grants']
const ENTRY_FIELDS: readonly string[] = ['userId', 'scope', 'expectedEmail']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(path: string, code: ManifestIssueCode, message: string): ManifestIssue {
  return { path, code, message }
}

/**
 * Strict, exhaustive, deterministic manifest validation.
 *
 * STRICT: unknown fields are refused at both levels rather than ignored. An
 * ignored field is how a `status: "active"`, a `force: true` or a
 * `grantedBy: …` ends up looking honoured while meaning nothing at all.
 *
 * EXHAUSTIVE: every problem in the document is reported, not just the first.
 * An operator fixing a hand-written list one error per run will stop reading
 * carefully by the third attempt.
 *
 * DETERMINISTIC: the same document always produces the same issues in the same
 * order. Unknown-field issues are emitted in sorted key order so that the JSON
 * writer's key ordering cannot reorder the report.
 *
 * `grants: []` IS VALID. It parses, and it plans nothing — the honest result
 * for an empty list, and a useful smoke test for the whole path.
 */
export function parseGrantManifest(input: unknown): ManifestParseResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [issue('$', 'not_an_object', 'The manifest must be a JSON object.')],
    }
  }

  const issues: ManifestIssue[] = []

  for (const key of Object.keys(input).sort()) {
    if (!TOP_LEVEL_FIELDS.includes(key)) {
      issues.push(
        issue(`$.${key}`, 'unknown_field', `Unknown top-level field '${key}'.`),
      )
    }
  }

  if (input.version !== MEMBERSHIP_GRANT_MANIFEST_VERSION) {
    issues.push(
      issue(
        '$.version',
        'unsupported_version',
        `version must be exactly ${MEMBERSHIP_GRANT_MANIFEST_VERSION}.`,
      ),
    )
  }

  const rawGrants = input.grants

  if (!Array.isArray(rawGrants)) {
    issues.push(
      issue(
        '$.grants',
        'grants_not_an_array',
        'grants must be an array. An empty array is valid and plans nothing.',
      ),
    )
    return { ok: false, issues }
  }

  if (rawGrants.length > MAX_MANIFEST_GRANTS) {
    issues.push(
      issue(
        '$.grants',
        'too_many_grants',
        `At most ${MAX_MANIFEST_GRANTS} grants per manifest; found ${rawGrants.length}.`,
      ),
    )
  }

  const grants: GrantRequest[] = []
  const seenUserIds = new Set<string>()

  for (let index = 0; index < rawGrants.length; index += 1) {
    const raw: unknown = rawGrants[index]
    const at = `$.grants[${index}]`

    if (!isPlainObject(raw)) {
      issues.push(issue(at, 'entry_not_an_object', 'Each grant must be a JSON object.'))
      continue
    }

    for (const key of Object.keys(raw).sort()) {
      if (!ENTRY_FIELDS.includes(key)) {
        issues.push(
          issue(`${at}.${key}`, 'unknown_field', `Unknown grant field '${key}'.`),
        )
      }
    }

    const userId = readUserId(raw.userId, at, issues, seenUserIds)
    const scope = readScope(raw.scope, at, issues)
    const expectedEmail = readExpectedEmail(raw, at, issues)

    if (userId !== null && scope !== null && expectedEmail !== undefined) {
      grants.push({ userId, scope, expectedEmail })
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  return { ok: true, manifest: { version: MEMBERSHIP_GRANT_MANIFEST_VERSION, grants } }
}

/** The lower-cased id, or `null` with issues recorded. Also detects duplicates. */
function readUserId(
  value: unknown,
  at: string,
  issues: ManifestIssue[],
  seen: Set<string>,
): string | null {
  if (typeof value !== 'string') {
    issues.push(
      issue(`${at}.userId`, 'missing_user_id', 'userId is required and must be a string.'),
    )
    return null
  }

  if (value.trim().length === 0) {
    issues.push(issue(`${at}.userId`, 'blank_user_id', 'userId must not be blank.'))
    return null
  }

  if (!USER_ID_PATTERN.test(value)) {
    issues.push(
      issue(
        `${at}.userId`,
        'malformed_user_id',
        'userId must be a canonical 8-4-4-4-12 UUID, matching users.id.',
      ),
    )
    return null
  }

  const normalized = value.toLowerCase()

  if (seen.has(normalized)) {
    issues.push(
      issue(
        `${at}.userId`,
        'duplicate_user_id',
        'This userId appears more than once. One membership per account.',
      ),
    )
    return null
  }

  seen.add(normalized)
  return normalized
}

function readScope(value: unknown, at: string, issues: ManifestIssue[]): GrantScope | null {
  if (typeof value !== 'string') {
    issues.push(
      issue(
        `${at}.scope`,
        'missing_scope',
        `scope is required and must be one of: ${GRANT_SCOPES.join(', ')}.`,
      ),
    )
    return null
  }

  if (!(GRANT_SCOPES as readonly string[]).includes(value)) {
    issues.push(
      issue(
        `${at}.scope`,
        'unknown_scope',
        `Unknown scope '${value}'. Only ${GRANT_SCOPES.join(' and ')} exist, and neither authorizes selling.`,
      ),
    )
    return null
  }

  return value as GrantScope
}

/**
 * `null` when the key was absent, the normalised address when it was valid, and
 * `undefined` to mean "present but rejected" — which is why the caller tests
 * for `undefined` rather than for falsiness.
 */
function readExpectedEmail(
  raw: Record<string, unknown>,
  at: string,
  issues: ManifestIssue[],
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, 'expectedEmail')) return null

  const value = raw.expectedEmail

  if (typeof value !== 'string') {
    issues.push(
      issue(
        `${at}.expectedEmail`,
        'malformed_expected_email',
        'expectedEmail, when present, must be a string. Omit the field instead of sending null.',
      ),
    )
    return undefined
  }

  const normalized = normalizeEmailForComparison(value)

  if (
    normalized.length === 0 ||
    normalized.length > EMAIL_MAX_LENGTH ||
    !EMAIL_SHAPE.test(normalized)
  ) {
    issues.push(
      issue(
        `${at}.expectedEmail`,
        'malformed_expected_email',
        'expectedEmail does not look like an email address.',
      ),
    )
    return undefined
  }

  return normalized
}

/* -------------------------------------------------------------------------- */
/* What the database already says                                              */
/* -------------------------------------------------------------------------- */

/**
 * A membership row as it comes off the wire — both columns as plain strings.
 *
 * Typed loosely ON PURPOSE, exactly as `resolveMarketplaceAccess()` treats its
 * input: Postgres cannot remove an enum value but it can gain one, so a build
 * older than its database will read scopes and statuses it has never heard of.
 * Loose strings force the planner to validate rather than to trust a type that
 * the driver never checked.
 */
export type MembershipRow = {
  scope: string
  status: string
}

/**
 * Everything the planner is allowed to know about one account.
 *
 * THREE FIELDS, AND NO FOURTH. There is no role here, no account status, no
 * owner flag, no order history, no store. Not because the planner promises not
 * to read them — because they are not present to read, which is the same
 * argument `lib/marketplace/access.ts` makes by taking no user at all.
 *
 * `email` is `null` unless THIS account's own grant asked for verification. The
 * adapter does not fetch what nothing needs, and `verifyIdentities()` drops an
 * address that arrives for an entry that never asked for one.
 */
export type AccountSnapshot = {
  userId: string
  email: string | null
  membership: MembershipRow | null
}

/* -------------------------------------------------------------------------- */
/* The staged read boundary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A live `users` row from the EXISTENCE lookup.
 *
 * ONE FIELD, AND NO SECOND. Not the address, not the role, not the account
 * status, not the created-at. The projection the adapter is permitted to ask
 * for is the shape of this type, and a column that is never fetched is a column
 * that can never be reasoned from by accident.
 */
export type LiveUserRow = {
  userId: string
}

/**
 * A row from the EMAIL VERIFICATION lookup — the only place an address appears.
 *
 * `email` is typed as nullable because the adapter must not have to promise
 * that a row it read has one; a missing address where verification was asked
 * for is a mismatch, which is the fail-closed answer.
 */
export type StoredEmailRow = {
  userId: string
  email: string | null
}

/** A `marketplace_access` row, still loosely typed, still keyed by account. */
export type StoredMembershipRow = {
  userId: string
  scope: string
  status: string
}

/**
 * What stage 1 is allowed to ask for, stated PER ID rather than per manifest.
 *
 * THE TWO LISTS ARE TWO DIFFERENT QUESTIONS, and they are separate because they
 * have different answers. "Does this account exist" is asked of every id the
 * operator wrote down. "What address is on file" is asked only of the ids whose
 * OWN entry supplied an `expectedEmail` to compare against.
 *
 * THIS REPLACES A SINGLE BOOLEAN, AND THAT MATTERS. A one-per-manifest "some
 * entry wants verification" flag makes a manifest of twenty-five grants with one
 * `expectedEmail` fetch twenty-five stored addresses to compare one of them.
 * Twenty-four of those reads answer no question anybody asked. The subset below
 * is exactly the ids that asked, so the other twenty-four addresses are never
 * projected, never returned and never in this process.
 *
 * Both lists are in manifest order, so the order rows come back in cannot reach
 * either query or the report.
 */
export type UserLookupRequest = {
  /** Every id the manifest named, in manifest order. Nothing else. */
  userIds: readonly string[]
  /**
   * Exactly the ids whose own grant carried an `expectedEmail`, in manifest
   * order. EMPTY MEANS NO ADDRESS IS FETCHED AT ALL — not a narrower query, no
   * query.
   */
  emailVerificationUserIds: readonly string[]
}

export function planUserLookup(manifest: GrantManifest): UserLookupRequest {
  return {
    userIds: manifest.grants.map((grant) => grant.userId),
    emailVerificationUserIds: manifest.grants
      .filter((grant) => grant.expectedEmail !== null)
      .map((grant) => grant.userId),
  }
}

export type VerifiedIdentities = {
  /** One entry per live account named by the manifest. Membership still `null`. */
  snapshots: ReadonlyMap<string, AccountSnapshot>
  /**
   * The ONLY ids whose membership may be read, in manifest order.
   *
   * An id is here when a live account exists for it and — if the operator
   * supplied an address — the stored address matches. Nothing else qualifies.
   */
  eligibleUserIds: readonly string[]
}

/**
 * STAGE 1: combine the two identity reads, and decide what stage 2 may read.
 *
 * TWO INPUTS, BECAUSE THERE WERE TWO QUERIES. `liveUsers` answers "which of
 * these ids is a live account" for every id the manifest named; `storedEmails`
 * answers "what address is on file" for the strictly smaller set of ids whose
 * own entry asked. They are joined HERE, in memory, which is what lets the
 * second read be narrow in the first place.
 *
 * AN ADDRESS THAT NOBODY ASKED FOR IS DROPPED, not stored. An entry with no
 * `expectedEmail` gets `email: null` in its snapshot even if a row for that id
 * somehow appears in `storedEmails` — the adapter is not supposed to fetch one,
 * and this is the half of that claim that holds if a future adapter does.
 *
 * WHY THE ORDER MATTERS EVEN THOUGH BOTH READS ARE READ-ONLY. Membership is the
 * fact the operator is asking about. Reading it for an id whose identity has not
 * been established means the tool has already looked up "is this person a
 * marketplace member" for an account nobody has confirmed is the intended one —
 * for a typo'd uuid, or for the account whose address disagrees with the one in
 * the manifest. Fetching it and then discarding it is not the same as never
 * fetching it, and the cheapest way to keep the two the same is to make the
 * second query's `IN` list a function of the first query's answer.
 *
 * THIS IS NOT A SECOND COPY OF THE POLICY. It decides exactly one thing — which
 * ids a membership read may name. It assigns no outcome, and it cannot: every
 * account it saw gets a snapshot, ineligible ones included, and `classify()`
 * below is still the only thing that says `user_not_found`,
 * `expected_email_mismatch` or anything else. An id refused here reaches the
 * planner with `membership: null`, and the planner refuses it on the address —
 * before it would have looked at membership anyway.
 *
 * MANIFEST ORDER, NOT ROW ORDER. Both outputs are built by walking the manifest,
 * so the order rows happened to come back in cannot reach the report or the
 * second query.
 */
export function verifyIdentities(
  manifest: GrantManifest,
  liveUsers: readonly LiveUserRow[],
  storedEmails: readonly StoredEmailRow[] = [],
): VerifiedIdentities {
  const requested = new Set(manifest.grants.map((grant) => grant.userId))
  const live = new Set(
    liveUsers.filter((row) => requested.has(row.userId)).map((row) => row.userId),
  )

  /* Only the ids that asked for verification may carry an address at all. */
  const asked = new Set(
    manifest.grants
      .filter((grant) => grant.expectedEmail !== null)
      .map((grant) => grant.userId),
  )
  const addresses = new Map(
    storedEmails
      .filter((row) => asked.has(row.userId))
      .map((row) => [row.userId, row.email] as const),
  )

  const entries: Array<readonly [string, AccountSnapshot]> = []
  const eligibleUserIds: string[] = []
  const seen = new Set<string>()

  for (const grant of manifest.grants) {
    if (seen.has(grant.userId)) continue
    seen.add(grant.userId)

    if (!live.has(grant.userId)) continue

    const email =
      grant.expectedEmail === null ? null : (addresses.get(grant.userId) ?? null)

    entries.push([
      grant.userId,
      { userId: grant.userId, email, membership: null },
    ] as const)

    const stored = email === null ? null : normalizeEmailForComparison(email)
    const verified =
      grant.expectedEmail === null || (stored !== null && stored === grant.expectedEmail)

    if (verified) eligibleUserIds.push(grant.userId)
  }

  return { snapshots: new Map(entries), eligibleUserIds }
}

/**
 * STAGE 2: attach the membership rows, and only for ids stage 1 cleared.
 *
 * The eligibility filter is applied AGAIN here, over rows that have already come
 * back. Not because the adapter is expected to over-fetch, but because "the
 * query was narrow" and "the planner only ever saw narrow data" are two
 * different claims, and this is the one that holds even if a future adapter
 * widens the query.
 */
export function attachMemberships(
  verified: VerifiedIdentities,
  membershipRows: readonly StoredMembershipRow[],
): ReadonlyMap<string, AccountSnapshot> {
  const eligible = new Set(verified.eligibleUserIds)
  const rows = new Map(
    membershipRows
      .filter((row) => eligible.has(row.userId))
      .map((row) => [row.userId, row] as const),
  )

  const entries: Array<readonly [string, AccountSnapshot]> = []

  for (const [userId, account] of verified.snapshots) {
    const row = rows.get(userId)

    entries.push([
      userId,
      row === undefined
        ? account
        : {
            userId: account.userId,
            email: account.email,
            membership: { scope: row.scope, status: row.status },
          },
    ] as const)
  }

  return new Map(entries)
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The outcome vocabulary. Exactly one applies to each requested membership.
 *
 * Ordered as it is printed, not alphabetically: the two harmless outcomes
 * first, then the refusals.
 */
export const GRANT_PLAN_OUTCOMES = [
  /** No row exists. A future apply step would create ONE active membership. */
  'grant_new_active',
  /** An active row with the requested scope already exists. Nothing to do. */
  'already_active_same_scope',
  /** No live `users` row for that id. Accounts are never created here. */
  'user_not_found',
  /** `expectedEmail` disagrees with the stored address. Fails closed. */
  'expected_email_mismatch',
  /** An active row exists with the OTHER scope. Never changed automatically. */
  'scope_conflict',
  /** A suspended row exists. Never reactivated automatically. */
  'membership_suspended',
  /** A revoked row exists. Never reactivated automatically. */
  'membership_revoked',
  /** The stored row carries a scope or status this build does not know. */
  'unrecognized_membership',
] as const

export type GrantPlanOutcome = (typeof GRANT_PLAN_OUTCOMES)[number]

/**
 * What the outcome means for a future, separately approved apply step.
 *
 * `would_grant` is a statement about a hypothetical later slice. Nothing in
 * this build acts on it.
 */
export type GrantPlanDisposition = 'would_grant' | 'no_change' | 'blocked'

export type PlannedGrant = {
  /** Position in the manifest, 0-based. Output is ordered by it. */
  index: number
  userId: string
  requestedScope: GrantScope
  outcome: GrantPlanOutcome
  disposition: GrantPlanDisposition
  /** The scope on the existing row when there was one this build understood. */
  existingScope: GrantScope | null
  existingStatus: MembershipStatus | null
  /** One line for a human. Never contains an email address. */
  detail: string
}

export type MembershipGrantPlan = {
  version: typeof MEMBERSHIP_GRANT_MANIFEST_VERSION
  entries: readonly PlannedGrant[]
  counts: Readonly<Record<GrantPlanOutcome, number>>
  wouldGrantCount: number
  noChangeCount: number
  blockedCount: number
  /**
   * TRUE MEANS "a later, separately reviewed step could consider this", AND
   * NOTHING MORE. It does not mean anything happened, and it never will in this
   * slice: there is no apply path in this repository to hand an applicable plan
   * to. One blocked entry makes the whole manifest inapplicable — a partially
   * applied grant list is the state nobody can reason about afterwards.
   */
  applicable: boolean
}

const DISPOSITION_BY_OUTCOME: Readonly<Record<GrantPlanOutcome, GrantPlanDisposition>> = {
  grant_new_active: 'would_grant',
  already_active_same_scope: 'no_change',
  user_not_found: 'blocked',
  expected_email_mismatch: 'blocked',
  scope_conflict: 'blocked',
  membership_suspended: 'blocked',
  membership_revoked: 'blocked',
  unrecognized_membership: 'blocked',
}

function knownScope(value: string): GrantScope | null {
  return (GRANT_SCOPES as readonly string[]).includes(value) ? (value as GrantScope) : null
}

function knownStatus(value: string): MembershipStatus | null {
  return (MEMBERSHIP_STATUSES as readonly string[]).includes(value)
    ? (value as MembershipStatus)
    : null
}

/**
 * Classify one requested membership. Pure, total, and refuses by default.
 *
 * THE ORDER OF THE TESTS IS THE POLICY:
 *
 *   1. NO ACCOUNT, NO PLAN. A missing snapshot is a refusal and never a
 *      creation — `user_not_found` is blocked, not "grant after signup".
 *   2. VERIFICATION BEFORE EVERYTHING ELSE. If the operator supplied an
 *      address and it disagrees with the account, the id is not trusted enough
 *      to reason about its membership, so nothing further is reported about it.
 *   3. NO ROW, requested scope, new active membership — the only outcome that
 *      would ever write anything.
 *   4. AN UNREADABLE ROW REFUSES. A scope or status this build does not know
 *      is refused rather than interpreted generously, for the same reason the
 *      resolver refuses it: a future third scope must not become a grant.
 *   5. NOT-ACTIVE REFUSES, per status, before scope is even considered.
 *      Reactivation is a human decision with a reason behind it; a planner that
 *      quietly proposes it turns a suspension into a formality.
 *   6. ACTIVE AND SAME SCOPE is a deterministic no-op — idempotence, so
 *      re-running a manifest is safe and boring.
 *   7. ACTIVE AND DIFFERENT SCOPE refuses. `shopper -> vendor` is an UPDATE of
 *      a real membership and a decision this tool does not get to make.
 */
function classify(
  request: GrantRequest,
  snapshot: AccountSnapshot | undefined,
): Omit<PlannedGrant, 'index' | 'userId' | 'requestedScope' | 'disposition'> {
  if (snapshot === undefined || snapshot.userId !== request.userId) {
    return {
      outcome: 'user_not_found',
      existingScope: null,
      existingStatus: null,
      detail: 'No live account with this id. This tool never creates accounts.',
    }
  }

  if (request.expectedEmail !== null) {
    const stored = snapshot.email === null ? null : normalizeEmailForComparison(snapshot.email)

    if (stored === null || stored !== request.expectedEmail) {
      return {
        outcome: 'expected_email_mismatch',
        existingScope: null,
        existingStatus: null,
        detail: 'expectedEmail does not match the address on record. Refused without inspecting membership.',
      }
    }
  }

  const row = snapshot.membership

  if (row === null) {
    return {
      outcome: 'grant_new_active',
      existingScope: null,
      existingStatus: null,
      detail: `No membership row exists; a new active ${request.scope} membership would be needed.`,
    }
  }

  const existingScope = knownScope(row.scope)
  const existingStatus = knownStatus(row.status)

  if (existingScope === null || existingStatus === null) {
    return {
      outcome: 'unrecognized_membership',
      existingScope: null,
      existingStatus: null,
      detail: 'The stored membership carries a scope or status this build does not understand.',
    }
  }

  if (existingStatus === 'suspended') {
    return {
      outcome: 'membership_suspended',
      existingScope,
      existingStatus,
      detail: 'A suspended membership exists. Reactivation is a human decision, never a planned one.',
    }
  }

  if (existingStatus === 'revoked') {
    return {
      outcome: 'membership_revoked',
      existingScope,
      existingStatus,
      detail: 'A revoked membership exists. Reactivation is a human decision, never a planned one.',
    }
  }

  if (existingScope === request.scope) {
    return {
      outcome: 'already_active_same_scope',
      existingScope,
      existingStatus,
      detail: 'An active membership with this exact scope already exists. Nothing to do.',
    }
  }

  return {
    outcome: 'scope_conflict',
    existingScope,
    existingStatus,
    detail: `An active '${existingScope}' membership exists; the manifest asks for '${request.scope}'. Scope is never changed automatically.`,
  }
}

/**
 * Plan every requested membership. Deterministic, side-effect free, read-only.
 *
 * OUTPUT ORDER IS INPUT ORDER, always. Not sorted by outcome, not grouped by
 * severity: a reviewer compares the report against the manifest line by line,
 * and a report that reorders itself makes that comparison a puzzle.
 *
 * EVERY ENTRY IS CLASSIFIED, including the ones after the first refusal. A
 * planner that stops at the first problem sends the operator round the loop
 * once per mistake, and each of those loops ends with a human deciding whether
 * to bother reading the rest.
 *
 * `accounts` is a plain map that the CALLER has already filled in. The planner
 * cannot look anything up: absence in the map is `user_not_found`, which is the
 * fail-closed answer whether the account is really missing or the lookup was
 * simply never done.
 *
 * The size ceiling is re-checked here because a `GrantManifest` can be built by
 * hand as well as parsed, and a limit enforced in only one of the two paths is
 * a limit with a way around it.
 */
export function planMembershipGrants(
  manifest: GrantManifest,
  accounts: ReadonlyMap<string, AccountSnapshot>,
): MembershipGrantPlan {
  if (manifest.grants.length > MAX_MANIFEST_GRANTS) {
    throw new RangeError(
      `A manifest may plan at most ${MAX_MANIFEST_GRANTS} grants; received ${manifest.grants.length}.`,
    )
  }

  const counts: Record<GrantPlanOutcome, number> = {
    grant_new_active: 0,
    already_active_same_scope: 0,
    user_not_found: 0,
    expected_email_mismatch: 0,
    scope_conflict: 0,
    membership_suspended: 0,
    membership_revoked: 0,
    unrecognized_membership: 0,
  }

  const entries: PlannedGrant[] = []
  let wouldGrantCount = 0
  let noChangeCount = 0
  let blockedCount = 0

  for (let index = 0; index < manifest.grants.length; index += 1) {
    const request = manifest.grants[index]
    const classification = classify(request, accounts.get(request.userId))
    const disposition = DISPOSITION_BY_OUTCOME[classification.outcome]

    counts[classification.outcome] += 1

    if (disposition === 'would_grant') wouldGrantCount += 1
    else if (disposition === 'no_change') noChangeCount += 1
    else blockedCount += 1

    entries.push({
      index,
      userId: request.userId,
      requestedScope: request.scope,
      disposition,
      ...classification,
    })
  }

  return {
    version: manifest.version,
    entries,
    counts,
    wouldGrantCount,
    noChangeCount,
    blockedCount,
    applicable: blockedCount === 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

const OUTCOME_COLUMN = 26

/**
 * The plan as lines of text. Pure, so the report is testable without a process.
 *
 * WHAT IT PRINTS IS THE MANIFEST BACK, PLUS A VERDICT. The user id came from
 * the operator's own file and is what identifies the line they are reviewing;
 * nothing else about the account is echoed. No email address is printed — not
 * the stored one, not the supplied one — because a mismatch report is useful
 * without either, and a plan is a file that gets pasted into a ticket.
 */
export function formatPlanReport(plan: MembershipGrantPlan): readonly string[] {
  const lines: string[] = [
    'DRY RUN — this tool reports only. No membership was created, changed,',
    'suspended, reactivated or revoked, and none can be from here.',
    '',
    `manifest version:  ${plan.version}`,
    `grants requested:  ${plan.entries.length}`,
    '',
  ]

  if (plan.entries.length === 0) {
    lines.push('No grants in this manifest. Nothing to plan.', '')
  }

  for (const entry of plan.entries) {
    const position = String(entry.index + 1).padStart(3, ' ')
    lines.push(
      `${position}. ${entry.userId}  ${entry.requestedScope.padEnd(7, ' ')}  ` +
        `${entry.outcome.padEnd(OUTCOME_COLUMN, ' ')}  ${entry.disposition}`,
    )
    lines.push(`     ${entry.detail}`)
  }

  if (plan.entries.length > 0) lines.push('')

  lines.push('outcome counts:')
  for (const outcome of GRANT_PLAN_OUTCOMES) {
    lines.push(`  ${outcome.padEnd(OUTCOME_COLUMN, ' ')}  ${plan.counts[outcome]}`)
  }

  lines.push(
    '',
    `would grant (NOT performed):  ${plan.wouldGrantCount}`,
    `already satisfied (no-op):    ${plan.noChangeCount}`,
    `blocked:                      ${plan.blockedCount}`,
    '',
    plan.applicable
      ? 'PLAN STATUS: consistent — every entry is either a clean new grant or already satisfied.'
      : `PLAN STATUS: NOT APPLICABLE — ${plan.blockedCount} blocked entr${plan.blockedCount === 1 ? 'y' : 'ies'}. Resolve each by hand.`,
    'Either way, nothing was written. Acting on this plan is a separate,',
    'separately reviewed step that does not exist in this build.',
  )

  return lines
}
