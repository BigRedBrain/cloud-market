/**
 * Marketplace membership grants — DRY-RUN PLANNER. THIS TOOL CANNOT WRITE.
 *
 * Run:
 *   npx tsx --env-file=.env.local --conditions=react-server \
 *     scripts/plan-marketplace-memberships.ts <path-to-manifest.json>
 *
 * (`--conditions=react-server` because `lib/db` imports `server-only`;
 * `--env-file` because the read-only lookup needs `DATABASE_URL`. Neither is a
 * capability flag of this script — this script takes no flags at all.)
 *
 * WHAT IT DOES. Reads a manifest an operator wrote and reviewed, reads the
 * minimum the database can tell it about those accounts, and prints what a
 * separate, separately approved step would have to do. Then it stops.
 *
 * WHAT IT CANNOT DO, BY CONSTRUCTION AND NOT BY PROMISE:
 *
 *   · It never writes. The only database verbs in this file are `select`,
 *     `from` and `where`. There is no apply mode, no execute mode, no force
 *     mode, no confirmation prompt that turns into one, and no flag of any
 *     kind — an argument beginning with `-` is refused outright, so a habit
 *     picked up from another tool cannot be typed in here by muscle memory.
 *     `scripts/verify-marketplace-membership-plan.ts` scans this file for
 *     mutation primitives and mutation SQL and fails if either appears.
 *   · It never emits SQL for someone else to run. A generated statement is a
 *     mutation with the review step moved somewhere nobody is looking.
 *   · It never creates accounts. An unknown id is a refusal.
 *   · It never writes a manifest, and it never reads one from inside this
 *     repository. Manifests are hand-authored, hand-reviewed inputs that live
 *     OUTSIDE the tree, because they contain real user ids and real addresses
 *     and neither belongs in version control. That is checked, not requested:
 *     the path as typed AND the path after links are followed must both be
 *     outside the repository root, or the file is never opened.
 *
 * READ-ONLY, AND NARROW, AND IN THAT ORDER. At most three selects, each keyed
 * by an explicit list of ids, and each list narrower than the one before it:
 *
 *   STAGE 1a asks `users` which of the named ids are live accounts. Bounded by
 *   the manifest's own ids, and it projects `users.id` AND NOTHING ELSE — not
 *   the address, which existence does not depend on.
 *   STAGE 1b asks `users` for the address on file, bounded to exactly the ids
 *   whose OWN entry supplied an `expectedEmail`. A manifest of twenty-five
 *   grants with one `expectedEmail` reads one address, not twenty-five, and a
 *   manifest with none issues this query at all.
 *   STAGE 2 asks `marketplace_access` about the ids that survived stage 1: the
 *   ones that exist and, where an address was supplied, match it. An unknown id
 *   and a mismatched address are never the subject of a membership question at
 *   all, and when nothing survives, the query is not issued.
 *
 * `users.role` and `users.status` are not merely unread — they are never
 * fetched, which is the same discipline `lookupMarketplaceMembership()` in
 * `lib/auth/dal.ts` follows and the reason membership has its own table.
 *
 * THE ADAPTER DECIDES WHAT MAY BE READ; THE PLANNER DECIDES WHAT IT MEANS. Every
 * account stage 1 saw reaches `planMembershipGrants()`, ineligible ones
 * included, and the planner alone assigns the outcome. Narrowing the reads does
 * not move a single classification out of the pure module.
 *
 * EXIT CODES. 0 when the manifest is valid and every entry is either a clean
 * new grant or already satisfied; 1 for a manifest inside the repository, a
 * malformed manifest, an unreadable file, a lookup failure, or a plan with any
 * blocked entry. Zero never means anything was applied — nothing is ever
 * applied.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { and, inArray, isNull } from 'drizzle-orm'

import { db } from '../lib/db'
import { marketplaceAccess, users } from '../lib/db/schema'
import {
  MAX_MANIFEST_GRANTS,
  MEMBERSHIP_GRANT_MANIFEST_VERSION,
  attachMemberships,
  checkManifestLocation,
  formatPlanReport,
  parseGrantManifest,
  planMembershipGrants,
  planUserLookup,
  verifyIdentities,
  type AccountSnapshot,
  type GrantManifest,
  type LiveUserRow,
  type StoredEmailRow,
  type StoredMembershipRow,
} from '../lib/marketplace/membership-grant-plan'

const USAGE = [
  'Usage: plan-marketplace-memberships.ts <path-to-manifest.json>',
  '',
  'Exactly one argument: the path to a manifest OUTSIDE this repository.',
  'A path inside the repository is refused before the file is opened, whether',
  'it is there directly or by way of a link that leads back in.',
  'This tool takes no options. There is no apply mode; it is a planner.',
  '',
  'Manifest shape:',
  `  { "version": ${MEMBERSHIP_GRANT_MANIFEST_VERSION}, "grants": [`,
  '      { "userId": "<users.id uuid>", "scope": "shopper" | "vendor",',
  '        "expectedEmail": "<optional verification address>" } ] }',
  '',
  `At most ${MAX_MANIFEST_GRANTS} grants per manifest. An empty grants array is valid.`,
]

/**
 * Anything that could carry a connection string is replaced before printing.
 *
 * Driver and environment errors are quoted to the operator because a silent
 * failure is worse, but `DATABASE_URL` embeds a password and error text is what
 * ends up pasted into a ticket.
 */
function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:[/][/][^\s'"]+/gi, '[redacted-connection-string]')
}

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/* Where the manifest may live                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The repository root, derived from where THIS FILE sits and nowhere else.
 *
 * NOT `process.cwd()`. The working directory is whatever the operator's shell
 * happened to be pointing at, which makes it an input to a boundary check that
 * the person crossing the boundary controls. This file is `<root>/scripts/…`, so
 * its own directory's parent is the root, whichever directory the command was
 * typed from.
 *
 * CANONICALISED, because the root is one half of every comparison below. If the
 * checkout itself is reached through a link, the lexical root and the real root
 * are different strings for the same directory, and a manifest inside it would
 * be inside only one of them.
 */
const REPOSITORY_ROOT = canonicalize(resolve(__dirname, '..'))

/** The real path of an existing directory or file; the input if it is not one. */
function canonicalize(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    try {
      return realpathSync(target)
    } catch {
      return resolve(target)
    }
  }
}

/**
 * The real path of `target`, even when `target` does not exist yet.
 *
 * `realpath` fails outright on a missing file, and "the file is not there" must
 * not be the reason a link-resolved boundary check gets skipped. So the deepest
 * ancestor that DOES exist is canonicalised and the remaining names are put back
 * on: a manifest named inside a symlinked directory therefore resolves into that
 * directory's real location whether or not the file itself exists.
 */
function canonicalizeDeepest(target: string): string {
  const trailing: string[] = []
  let current = resolve(target)

  for (;;) {
    try {
      const real = realpathSync.native(current)
      return trailing.length === 0 ? real : resolve(real, ...trailing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      trailing.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Windows and macOS both hand back the same file for two spellings that differ
 * only in case, so a case-sensitive comparison there would let `…/LIB/x.json`
 * pass a check that `…/lib/x.json` fails. Everywhere else, two spellings are two
 * files and folding case would refuse paths that are genuinely outside.
 */
const CASE_INSENSITIVE_FILESYSTEM =
  process.platform === 'win32' || process.platform === 'darwin'

/**
 * Refuse a manifest inside the repository, BEFORE the file is opened.
 *
 * Returns the two paths so the caller can name them in the report. Nothing here
 * copies, moves, creates or rewrites anything: the manifest is an input, and an
 * input that is in the wrong place is a refusal, not something to relocate.
 */
function locateManifest(argument: string): { declaredPath: string; resolvedPath: string } {
  const declaredPath = resolve(argument)
  const resolvedPath = canonicalizeDeepest(declaredPath)

  const location = checkManifestLocation({
    repositoryRoot: REPOSITORY_ROOT,
    declaredPath,
    resolvedPath,
    caseInsensitive: CASE_INSENSITIVE_FILESYSTEM,
  })

  if (location.verdict === 'outside_repository') return { declaredPath, resolvedPath }

  fail([
    location.verdict === 'unusable_path'
      ? 'That manifest path could not be compared against the repository root.'
      : 'That manifest path is inside this repository, so it was refused.',
    '',
    `  path as given:    ${declaredPath}`,
    `  path it resolves: ${resolvedPath}`,
    `  repository root:  ${REPOSITORY_ROOT}`,
    `  verdict:          ${location.verdict}${location.offending === null ? '' : ` (${location.offending})`}`,
    '',
    'A manifest names real accounts and real addresses. It belongs outside the',
    'tree, and neither a copy in the tree nor a link pointing back into it will',
    'be opened. The file was not read, parsed or looked up.',
  ])
}

/**
 * STAGE 1a. Which of the named ids are live accounts. Existence, and no more.
 *
 * BOUNDED BY THE MANIFEST. `inArray` over ids the manifest named — no wildcard
 * scan, no backfill query, no "everyone who looks like a customer".
 *
 * SOFT-DELETED ACCOUNTS ARE NOT FOUND. `isNull(users.deletedAt)`, the same
 * predicate every other account lookup in the repository uses. A deleted
 * account that reappears as a marketplace member would be a surprising way to
 * undo a deletion.
 *
 * THE PROJECTION IS `users.id` AND NOTHING ELSE. Not the address — an id whose
 * entry asked no verification question has no address worth reading, and this
 * query cannot tell which ids those are because it does not need to. Not
 * `users.role`, not `users.status`, which are never fetched anywhere here.
 */
async function readLiveUserIds(ids: readonly string[]): Promise<readonly LiveUserRow[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))

  return rows.map((row) => ({ userId: row.id }))
}

/**
 * STAGE 1b. The address on file, for the ids that asked to have one checked.
 *
 * BOUNDED TO THE SUBSET, NOT TO THE MANIFEST. The `IN` list is
 * `request.emailVerificationUserIds` — the ids whose own entry carried an
 * `expectedEmail` — so an entry that asked no question about an address causes
 * no address to be read. The caller does not call this at all when that subset
 * is empty.
 *
 * STILL ONLY LIVE ACCOUNTS: a soft-deleted account's address is not read either.
 */
async function readVerificationEmails(
  ids: readonly string[],
): Promise<readonly StoredEmailRow[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))

  return rows.map((row) => ({ userId: row.id, email: row.email }))
}

/**
 * STAGE 2. Membership, for verified ids only.
 *
 * The `IN` list is `verifiedIds` — the output of stage 1 — and never the raw
 * manifest. An id this function is not given is an id `marketplace_access` is
 * never asked about.
 */
async function readMemberships(
  verifiedIds: readonly string[],
): Promise<readonly StoredMembershipRow[]> {
  const rows = await db
    .select({
      userId: marketplaceAccess.userId,
      scope: marketplaceAccess.scope,
      status: marketplaceAccess.status,
    })
    .from(marketplaceAccess)
    .where(inArray(marketplaceAccess.userId, [...verifiedIds]))

  return rows.map((row) => ({ userId: row.userId, scope: row.scope, status: row.status }))
}

/**
 * The read-only lookup adapter: identity first, membership second, or not at all.
 *
 * Every decision below belongs to the pure module — which ids may be asked
 * about, which of them may have an address read, which survive verification,
 * and how the answers become snapshots. This function is the part that cannot
 * be pure: it issues the queries, in that order, and skips each one whose id
 * list the pure module left empty.
 *
 * THE EMAIL QUERY IS NOT A NARROWED VERSION OF THE EXISTENCE QUERY; it is a
 * different question asked of a different, strictly smaller list. Combining the
 * two answers happens in `verifyIdentities()`, in memory, which is precisely
 * what lets the second list be smaller than the first.
 *
 * An empty manifest touches nothing at all and no connection is ever opened.
 */
async function lookupAccounts(
  manifest: GrantManifest,
): Promise<ReadonlyMap<string, AccountSnapshot>> {
  const request = planUserLookup(manifest)

  if (request.userIds.length === 0) return new Map()

  const liveUsers = await readLiveUserIds(request.userIds)
  const storedEmails =
    request.emailVerificationUserIds.length === 0
      ? []
      : await readVerificationEmails(request.emailVerificationUserIds)

  const verified = verifyIdentities(manifest, liveUsers, storedEmails)

  if (verified.eligibleUserIds.length === 0) return verified.snapshots

  const membershipRows = await readMemberships(verified.eligibleUserIds)

  return attachMemberships(verified, membershipRows)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length !== 1) {
    fail([
      args.length === 0
        ? 'No manifest path given.'
        : `Expected exactly one argument, received ${args.length}.`,
      '',
      ...USAGE,
    ])
  }

  const argument = args[0]

  if (argument.startsWith('-')) {
    fail([
      `'${argument}' looks like an option. This tool has none — not to apply a`,
      'plan, not to force one, not to write anything. Pass a manifest path.',
      '',
      ...USAGE,
    ])
  }

  /*
   * THE BOUNDARY CHECK COMES FIRST — before the file is opened, before it is
   * parsed, before a single row is read. A manifest in the wrong place is
   * refused on the strength of its path alone.
   */
  const { declaredPath, resolvedPath } = locateManifest(argument)
  const manifestPath = declaredPath

  let text = ''
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    fail([
      `Could not read the manifest at ${manifestPath}.`,
      redact(error instanceof Error ? error.message : String(error)),
    ])
  }

  let document: unknown = null
  try {
    document = JSON.parse(text)
  } catch (error) {
    fail([
      `The manifest at ${manifestPath} is not valid JSON.`,
      error instanceof Error ? error.message : String(error),
    ])
  }

  const parsed = parseGrantManifest(document)

  if (!parsed.ok) {
    fail([
      `The manifest at ${manifestPath} was refused — ${parsed.issues.length} problem(s):`,
      '',
      ...parsed.issues.map((problem) => `  ${problem.path}  [${problem.code}]  ${problem.message}`),
      '',
      'Nothing was read from the database and nothing was planned.',
    ])
  }

  let accounts: ReadonlyMap<string, AccountSnapshot> = new Map()
  try {
    accounts = await lookupAccounts(parsed.manifest)
  } catch (error) {
    fail([
      'The read-only account lookup failed. No plan was produced.',
      redact(error instanceof Error ? error.message : String(error)),
    ])
  }

  const plan = planMembershipGrants(parsed.manifest, accounts)

  console.log('')
  console.log(`manifest:          ${manifestPath}`)
  if (resolvedPath !== manifestPath) console.log(`resolves to:       ${resolvedPath}`)
  console.log(`repository root:   ${REPOSITORY_ROOT}`)
  for (const line of formatPlanReport(plan)) console.log(line)
  console.log('')

  process.exit(plan.applicable ? 0 : 1)
}

/**
 * A rejection here is a bug in the planner, not a partial write — there is no
 * write to be partial. It still exits non-zero and still redacts.
 */
main().catch((error: unknown) => {
  fail([
    'The planner failed before it produced a plan. Nothing was written.',
    redact(error instanceof Error ? error.message : String(error)),
  ])
})
