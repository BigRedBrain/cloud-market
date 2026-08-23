/**
 * Private-marketplace access — decision checks and unwired-ness checks.
 *
 * Run: npm run test:marketplace-access
 *
 * HERMETIC BY CONSTRUCTION. No database, no network, no `.env.local`, no
 * request scope. `lib/marketplace/access.ts` has no imports at all — that is
 * asserted below rather than assumed — so it loads in a bare Node process, and
 * every decision here is produced by the function that will gate production
 * rather than by a stand-in for it. The only other module imported for values
 * is `lib/db/schema`, which reaches drizzle and nothing else; `getTableConfig`
 * and `enumValues` read metadata, they do not open a connection.
 *
 * WHAT THIS IS PROVING. Not that the code runs, but four claims that are
 * invisible from reading any single file:
 *
 *   1. MEMBERSHIP IS NOT DERIVED FROM THE ACCOUNT. The resolver is never handed
 *      a user, so `users.role` and `users.status` cannot reach the decision.
 *      Asserted structurally as well as by signature, because the tempting
 *      "just let admins in" fix would be one parameter away.
 *   2. ONLY `active` ADMITS, and missing / suspended / revoked each deny with
 *      their own reason.
 *   3. VENDOR SCOPE IS ENTRY, NOT SELLING. An active vendor is granted, and
 *      `authorizesSelling` still says no. This is the inference most likely to
 *      be made by accident later.
 *   4. THE GUARD IS UNWIRED. `requireMarketplaceAccess` appears nowhere in the
 *      tree except its own definition and this file. The table is empty, so a
 *      call site added today locks out every account on the platform — that is
 *      what this scan exists to catch, and it must be removed deliberately as
 *      part of the wiring batch, not quietly to make a check pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  MARKETPLACE_ACCESS_STATUSES,
  MARKETPLACE_SCOPES,
  authorizesSelling,
  deniedForAnonymous,
  resolveMarketplaceAccess,
  type MarketplaceAccessDecision,
  type MarketplaceAccessStatus,
  type MarketplaceMembership,
  type MarketplaceScope,
} from '../lib/marketplace/access'
import {
  marketplaceAccessStatus,
  marketplaceScope,
  type MarketplaceAccessStatus as SchemaAccessStatus,
  type MarketplaceScope as SchemaScope,
} from '../lib/db/schema'

const ROOT = join(__dirname, '..')

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const pass = a === e
  if (!pass) failures += 1
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        expected ${e}\n        actual   ${a}`),
  )
}

function assert(name: string, condition: boolean, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `\n        ${detail}`}`)
}

function source(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8').replace(/\r\n/g, '\n')
}

/** Source text with comments removed, so structural checks read code only. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** A top-level `export function` / `export async function`, to its closing brace. */
function extractFunction(text: string, name: string): string {
  const start = text.search(new RegExp(`export (?:async )?function ${name}\\b`))
  if (start === -1) return ''
  const end = text.indexOf('\n}', start)
  return end === -1 ? text.slice(start) : text.slice(start, end + 2)
}

/** Every source file in the repository, excluding build output and deps. */
function sourceFiles(): string[] {
  /* `drizzle/` is generated SQL and journal JSON; nothing there can call code. */
  const skipDirectories = new Set(['node_modules', 'drizzle'])
  const extensions = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx']
  const found: string[] = []

  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        /* Dot directories are build output and tooling state: .next, .git, .vercel. */
        if (!skipDirectories.has(entry) && !entry.startsWith('.')) walk(full)
      } else if (extensions.some((extension) => entry.endsWith(extension))) {
        found.push(full)
      }
    }
  }

  walk(ROOT)
  return found
}

/** Fixture rows. Built through the exported type so a shape change fails here. */
function membership(
  scope: MarketplaceMembership['scope'],
  status: MarketplaceMembership['status'],
): MarketplaceMembership {
  return { scope, status }
}

/** `granted` plus `reason`, as one comparable string. */
function outcome(decision: MarketplaceAccessDecision): string {
  return `${decision.granted ? 'granted' : 'denied'}:${decision.reason}`
}

/** Every reason this run actually produced, for the coverage check at the end. */
const reasonsSeen = new Set<string>()

function record(decision: MarketplaceAccessDecision): MarketplaceAccessDecision {
  reasonsSeen.add(decision.reason)
  return decision
}

function main() {
  console.log('\n-- vocabulary matches the pg enums ----------------------')

  /*
   * `lib/marketplace/access.ts` restates these lists so it can stay
   * dependency-free. That is only safe while the restatement is checked: a
   * scope added to the database and not to the resolver would be refused as
   * `unrecognized_membership`, which fails closed but silently, and a status
   * added to the resolver and not the database would be dead code pretending
   * to be a decision.
   */
  check(
    'MARKETPLACE_SCOPES equals marketplace_scope, in order',
    [...MARKETPLACE_SCOPES],
    [...marketplaceScope.enumValues],
  )
  check(
    'MARKETPLACE_ACCESS_STATUSES equals marketplace_access_status, in order',
    [...MARKETPLACE_ACCESS_STATUSES],
    [...marketplaceAccessStatus.enumValues],
  )

  /*
   * Type-level halves of the same claim, in both directions. These cost nothing
   * at runtime and fail at `npm run typecheck` rather than here.
   */
  const scopesAsSchema: readonly SchemaScope[] = [...MARKETPLACE_SCOPES]
  const schemaAsScopes: readonly MarketplaceScope[] = [...marketplaceScope.enumValues]
  const statusesAsSchema: readonly SchemaAccessStatus[] = [...MARKETPLACE_ACCESS_STATUSES]
  const schemaAsStatuses: readonly MarketplaceAccessStatus[] = [
    ...marketplaceAccessStatus.enumValues,
  ]
  assert(
    'the two vocabularies are mutually assignable (this one fails at typecheck)',
    scopesAsSchema.length === schemaAsScopes.length &&
      statusesAsSchema.length === schemaAsStatuses.length,
  )

  console.log('\n-- grants -----------------------------------------------')

  {
    const decision = record(resolveMarketplaceAccess(membership('shopper', 'active')))
    check('active shopper is granted entry', outcome(decision), 'granted:active_membership')
    check(
      'and the decision carries the shopper scope',
      decision.granted ? decision.scope : null,
      'shopper',
    )
  }

  {
    const decision = record(resolveMarketplaceAccess(membership('vendor', 'active')))
    check('active vendor is granted entry', outcome(decision), 'granted:active_membership')
    check(
      'and the decision carries the vendor scope',
      decision.granted ? decision.scope : null,
      'vendor',
    )
  }

  console.log('\n-- denials ----------------------------------------------')

  check(
    'a missing membership row denies',
    outcome(record(resolveMarketplaceAccess(null))),
    'denied:no_membership',
  )
  check(
    'and reports no scope, because there is no row to read one from',
    resolveMarketplaceAccess(null).scope,
    null,
  )
  check(
    'an anonymous request denies as not_signed_in, not as a missing row',
    outcome(record(deniedForAnonymous())),
    'denied:not_signed_in',
  )

  for (const scope of MARKETPLACE_SCOPES) {
    check(
      `suspended ${scope} is denied`,
      outcome(record(resolveMarketplaceAccess(membership(scope, 'suspended')))),
      'denied:membership_suspended',
    )
    check(
      `revoked ${scope} is denied`,
      outcome(record(resolveMarketplaceAccess(membership(scope, 'revoked')))),
      'denied:membership_revoked',
    )
    check(
      `a denied ${scope} still reports its scope, so support can see the row`,
      resolveMarketplaceAccess(membership(scope, 'suspended')).scope,
      scope,
    )
  }

  /*
   * Exhaustive over the whole vocabulary, so a scope or status added later is
   * covered here the moment the alignment check above forces it into the list.
   * The expectation is derived from `status === 'active'` alone — if any future
   * combination admits for some other reason, this is where it surfaces.
   */
  for (const scope of MARKETPLACE_SCOPES) {
    for (const status of MARKETPLACE_ACCESS_STATUSES) {
      check(
        `${scope}/${status} admits iff status is active`,
        resolveMarketplaceAccess(membership(scope, status)).granted,
        status === 'active',
      )
    }
  }

  console.log('\n-- unknown values fail closed ---------------------------')

  /*
   * Postgres cannot remove an enum value but it can gain one, and a deployment
   * running older code against a newer database will read values it has never
   * heard of. The casts here are the point: they reproduce exactly what the
   * driver would hand over, with no compile-time protection in the way.
   */
  const unknownScope = { scope: 'operator', status: 'active' } as unknown as MarketplaceMembership
  const unknownStatus = { scope: 'vendor', status: 'pending' } as unknown as MarketplaceMembership

  check(
    'an unrecognised SCOPE is refused, never admitted generously',
    outcome(record(resolveMarketplaceAccess(unknownScope))),
    'denied:unrecognized_membership',
  )
  check(
    'an unrecognised STATUS is refused',
    outcome(record(resolveMarketplaceAccess(unknownStatus))),
    'denied:unrecognized_membership',
  )
  check(
    'and neither claims a scope it did not understand',
    [
      resolveMarketplaceAccess(unknownScope).scope,
      resolveMarketplaceAccess(unknownStatus).scope,
    ],
    [null, null],
  )

  console.log('\n-- vendor scope is entry, NOT selling -------------------')

  const activeVendor = resolveMarketplaceAccess(membership('vendor', 'active'))

  assert(
    'the active vendor above IS admitted to the marketplace',
    activeVendor.granted,
    'the separation below is only meaningful against a grant',
  )
  check('yet selling is NOT authorized for it', authorizesSelling(activeVendor), false)
  check(
    'nor for an active shopper',
    authorizesSelling(resolveMarketplaceAccess(membership('shopper', 'active'))),
    false,
  )
  check('nor for a denial', authorizesSelling(resolveMarketplaceAccess(null)), false)

  const accessSource = source('lib', 'marketplace', 'access.ts')
  const accessCode = stripComments(accessSource)
  const sellingBody = stripComments(extractFunction(accessSource, 'authorizesSelling'))

  assert(
    'authorizesSelling() was found',
    sellingBody.length > 0,
    'extraction failed — the assertions about it are meaningless',
  )
  assert(
    'it is declared to return the literal false, not boolean',
    /function authorizesSelling\([^)]*\): false\b/.test(accessCode),
    'a boolean return could be widened to a conditional without the signature moving',
  )
  assert(
    'and its body contains no branch and no true',
    !sellingBody.includes('true') &&
      !sellingBody.includes('if ') &&
      !sellingBody.includes('?'),
    'selling rights come from vendors + vendor_memberships + compliance, none of which exist',
  )
  assert(
    'nothing in the resolver mentions selling, listing, payout or inventory rights',
    !/\b(canSell|isSeller|sellerOf|payout|listingRight)\b/i.test(accessCode),
  )

  console.log('\n-- the resolver is pure and account-blind ---------------')

  assert(
    'lib/marketplace/access.ts has NO imports at all',
    !/^\s*import\b/m.test(accessCode) && !/\brequire\(/.test(accessCode),
    'dependency-free is what lets this file be tested exactly as production runs it',
  )
  assert(
    'it never reads users.role or users.status',
    !/\buserRole\b/.test(accessCode) &&
      !/\buserStatus\b/.test(accessCode) &&
      !/\buser\.role\b/.test(accessCode) &&
      !/\buser\.status\b/.test(accessCode) &&
      !/\bSessionUser\b/.test(accessCode),
    'marketplace membership is a separate fact from what the account is to the storefront',
  )
  assert(
    'it is not even given a user to read them from',
    /function resolveMarketplaceAccess\(\s*membership: MarketplaceMembership \| null,?\s*\)/.test(
      accessCode,
    ),
    'the membership row is the only input; adding a user parameter is the change to argue about',
  )
  assert(
    'it performs no I/O and raises no navigation interrupt',
    !accessCode.includes('await ') &&
      !accessCode.includes('async ') &&
      !accessCode.includes('forbidden(') &&
      !accessCode.includes('redirect(') &&
      !accessCode.includes('recordAuditEvent'),
    'a side effect here would fire on silent UI probes too',
  )

  console.log('\n-- DAL binding ------------------------------------------')

  const dalSource = source('lib', 'auth', 'dal.ts')
  const guardBody = stripComments(extractFunction(dalSource, 'requireMarketplaceAccess'))
  const dalCode = stripComments(dalSource)

  assert(
    'requireMarketplaceAccess() was found in the DAL',
    guardBody.length > 0,
    'extraction failed — the rest of this section is meaningless',
  )
  assert(
    'the probe is cache()-wrapped, per the DAL convention',
    /export const getMarketplaceAccess = cache\(/.test(dalCode),
    'a layout, a page and the guard in one render must not be three queries',
  )
  assert(
    'the guard is NOT cache()-wrapped',
    !dalCode.includes('requireMarketplaceAccess = cache('),
    'it throws navigation interrupts; memoising those is the documented DAL rule',
  )
  assert(
    'the guard authenticates first, so anonymous reaches sign-in and not a 403',
    guardBody.includes('requireUser()'),
  )
  {
    /*
     * Presence is checked before order. A bare `indexOf(a) < indexOf(b)` reports
     * success when `a` is missing entirely, because -1 is less than everything.
     */
    const authAt = guardBody.indexOf('requireUser()')
    const probeAt = guardBody.indexOf('getMarketplaceAccess()')
    assert(
      'and does so BEFORE resolving membership',
      authAt >= 0 && probeAt >= 0 && authAt < probeAt,
      `requireUser() at ${authAt}, probe at ${probeAt}`,
    )
  }
  assert(
    'it uses requireUser(), not requireVerifiedUser()',
    !guardBody.includes('requireVerifiedUser'),
    'membership and email verification are separate gates',
  )
  assert(
    'it denies with forbidden()',
    guardBody.includes('forbidden()'),
    'an authenticated non-member is refused, not bounced to a login form',
  )
  {
    const start = dalSource.indexOf('export const getMarketplaceAccess = cache(')
    const end = dalSource.indexOf('\n)', start)
    const probeBody =
      start === -1
        ? ''
        : stripComments(dalSource.slice(start, end === -1 ? undefined : end + 2))

    assert('getMarketplaceAccess() was found in the DAL', probeBody.length > 0)
    assert(
      'the probe stays a silent, non-throwing decision — no forbidden(), no redirect()',
      !probeBody.includes('forbidden(') && !probeBody.includes('redirect('),
      'it runs on ordinary renders; it reports, the guard decides',
    )
    assert(
      'and answers anonymous with the resolver vocabulary, not a hand-built object',
      probeBody.includes('deniedForAnonymous()'),
      'a caller that assembles its own decision can invent a reason, or a grant',
    )
  }
  assert(
    'neither the probe nor the guard writes an audit event',
    !dalCode
      .slice(dalCode.indexOf('lookupMarketplaceMembership'))
      .includes('recordAuditEvent'),
    'audit_log has no marketplace event values yet; adding one is a schema change',
  )
  assert(
    'the membership query selects scope and status only',
    /select\(\{ scope: marketplaceAccess\.scope, status: marketplaceAccess\.status \}\)/.test(
      dalCode,
    ),
    'role and status on users must not merely be unread — they must not be fetched',
  )
  assert(
    'the membership query is scoped to one user and limited to one row',
    /eq\(marketplaceAccess\.userId, userId\)/.test(dalCode) &&
      dalCode.slice(dalCode.indexOf('lookupMarketplaceMembership')).includes('.limit(1)'),
  )
  assert(
    'the DAL does not fall back to users.role or users.status for membership',
    !/marketplace[\s\S]{0,400}?\buser\.role\b/i.test(
      dalCode.slice(dalCode.indexOf('lookupMarketplaceMembership')),
    ),
    'an admin is not thereby a marketplace member',
  )

  console.log('\n-- the guard is UNWIRED ---------------------------------')

  /*
   * The load-bearing section. `marketplace_access` is empty, so the first call
   * site denies every account on the platform including the owner. Removing an
   * entry from this allowlist is the deliberate act that turns enforcement on,
   * and it belongs to a batch that also runs the grandfathering backfill.
   */
  const allowed = new Set([
    join('lib', 'auth', 'dal.ts'),
    join('scripts', 'verify-marketplace-access.ts'),
  ])

  const files = sourceFiles()
  assert(
    'the tree scan actually found files',
    files.length > 50,
    `only ${files.length} scanned — a scan that finds nothing passes everything`,
  )

  const guardCallSites: string[] = []
  const moduleImporters: string[] = []

  for (const file of files) {
    const relativePath = relative(ROOT, file)
    if (allowed.has(relativePath)) continue

    const text = readFileSync(file, 'utf8')
    if (text.includes('requireMarketplaceAccess')) guardCallSites.push(relativePath)
    if (/from ['"](?:@\/|\.{1,2}\/)?(?:\.\.\/)*lib\/marketplace\/access['"]/.test(text)) {
      moduleImporters.push(relativePath)
    }
  }

  assert(
    'requireMarketplaceAccess has ZERO call sites outside its own definition',
    guardCallSites.length === 0,
    `found in: ${guardCallSites.join(', ')}`,
  )
  assert(
    'lib/marketplace/access.ts is imported by nothing but the DAL and this file',
    moduleImporters.length === 0,
    `imported by: ${moduleImporters.join(', ')}`,
  )

  /*
   * Named explicitly as well as covered by the scan above. These are the paths
   * the acceptance criteria call out, and naming them means the report says
   * which boundary held rather than only that some scan passed.
   */
  for (const [label, segments] of [
    ['app routes and pages', ['app']],
    ['the proxy', ['proxy.ts']],
    ['catalog queries', ['lib', 'catalog']],
    ['auth actions (sign-up)', ['lib', 'auth', 'actions.ts']],
  ] as const) {
    const prefix = join(...segments)
    const hits = guardCallSites.filter(
      (path) => path === prefix || path.startsWith(prefix + sep),
    )
    assert(`no call sites in ${label}`, hits.length === 0, hits.join(', '))
  }

  console.log('\n-- reason coverage --------------------------------------')

  check(
    'every decision reason was exercised above',
    [...reasonsSeen].sort(),
    [
      'active_membership',
      'membership_revoked',
      'membership_suspended',
      'no_membership',
      'not_signed_in',
      'unrecognized_membership',
    ],
  )

  console.log(
    `\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s)\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main()
