/**
 * Private-marketplace access — decision checks and wiring checks.
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
 * WHAT THIS IS PROVING. Not that the code runs, but five claims that are
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
 *   4. THE GUARD IS WIRED TO EXACTLY THREE ROUTES, and to nothing else. The
 *      allowlist below is exact in both directions: a fourth call site fails,
 *      and one of the three losing its call fails just as loudly. Call sites
 *      are counted from comment-stripped, string-blanked source, so prose about
 *      the guard is prose and only an invocation counts as an invocation.
 *   5. THE SHOP LINK IS EARNED, NOT ASSUMED. `SiteNav` reaches `/shop` only
 *      through an exact `=== 'granted'` test and reaches `/gate` on every other
 *      path — denied, unknown, omitted. That is proven SEMANTICALLY: the local
 *      identifier being compared may be named anything, what is checked is that
 *      it traces back to the prop, that the granted branch resolves to `/shop`,
 *      and that no other route into `/shop` exists in the component at all.
 *
 *   6. THE WRAPPER ONLY CARRIES THE DECISION. `CustomerSiteNav` is the Server
 *      Component the customer pages render for the notification bell. It
 *      forwards `marketplaceEntry` to `SiteNav` unchanged and resolves no
 *      membership itself, so claim 5 still describes what a page renders.
 *
 * WHY BOTH 4 AND 5. The guard is the boundary; the nav is only a signpost. A
 * hidden link is not a check, which is why the private routes are required to
 * call the guard BEFORE they read the catalogue — and why the nav is required
 * to fail closed anyway, so that a signed-out visitor is pointed at the gate
 * instead of at a 403.
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

/**
 * Comment-stripped source with quoted string literals emptied.
 *
 * For CALL-SITE analysis only. A doc block that names the guard, a denial
 * message that quotes it, or a `typeof` reference to it are all documentation
 * about enforcement rather than enforcement, and counting them turns this scan
 * into a scan for the word instead of for the call.
 *
 * Only `'…'` and `"…"` are blanked — never template literals, because a
 * template can contain a real `${await requireMarketplaceAccess()}` and losing
 * that would be a false negative in the one direction that matters.
 */
function codeOnly(text: string): string {
  return stripComments(text)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/** An invocation, not a mention: the name, ordinary whitespace, then `(`. */
const GUARD_CALL = /\brequireMarketplaceAccess\s*\(/

function callsGuard(text: string): boolean {
  return GUARD_CALL.test(codeOnly(text))
}

type NavLiteralSpan = {
  value: string
  start: number
  end: number
}

function navMatchingBrace(code: string, open: number): number {
  let depth = 0

  for (let i = open; i < code.length; i += 1) {
    const character = code[i]

    if (character === "'" || character === '"' || character === '`') {
      i += 1
      while (i < code.length && code[i] !== character) {
        i += code[i] === '\\' ? 2 : 1
      }
      continue
    }

    if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function navStringConstants(code: string): Map<string, NavLiteralSpan> {
  const found = new Map<string, NavLiteralSpan>()
  const declaration =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=\s*(['"`])([^'"`]*)\2/g

  let match: RegExpExecArray | null

  while ((match = declaration.exec(code)) !== null) {
    const start = match.index + match[0].length - (match[3].length + 2)

    found.set(match[1], {
      value: match[3],
      start,
      end: start + match[3].length + 2,
    })
  }

  return found
}

function navHrefObjectConstants(code: string): Map<string, NavLiteralSpan> {
  const found = new Map<string, NavLiteralSpan>()
  const declaration =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\{/g

  let match: RegExpExecArray | null

  while ((match = declaration.exec(code)) !== null) {
    const open = match.index + match[0].length - 1
    const close = navMatchingBrace(code, open)

    if (close === -1) continue

    const body = code.slice(open, close + 1)
    const href = /(?:^|[{,\s])href\s*:\s*(['"`])([^'"`]*)\1/.exec(body)

    if (!href) continue

    const start = open + href.index + href[0].indexOf(href[1])

    found.set(match[1], {
      value: href[2],
      start,
      end: start + href[2].length + 2,
    })
  }

  return found
}

/**
 * The header at `start` plus its balanced body.
 *
 * Delimiters are counted rather than searched for: a route component signed
 * `function ShopPage({ searchParams }: { … }) {` closes a brace in column zero
 * before its body has even begun, so "up to the next `\n}`" would return the
 * signature and nothing else — and an ordering assertion over an empty body
 * reports a guard that is missing rather than one that is late.
 *
 * The parameter list is walked to its matching `)` first, so only the brace
 * that opens the body is counted as opening the body.
 */
function functionBodyFrom(text: string, start: number): string {
  const open = text.indexOf('(', start)
  if (open === -1) return ''

  let depth = 0
  let cursor = open
  for (; cursor < text.length; cursor += 1) {
    if (text[cursor] === '(') depth += 1
    else if (text[cursor] === ')' && (depth -= 1) === 0) break
  }

  const bodyStart = text.indexOf('{', cursor)
  if (bodyStart === -1) return ''

  depth = 0
  for (cursor = bodyStart; cursor < text.length; cursor += 1) {
    if (text[cursor] === '{') depth += 1
    else if (text[cursor] === '}' && (depth -= 1) === 0) return text.slice(start, cursor + 1)
  }

  return text.slice(start)
}

/** A top-level `export function` / `export async function`, comment-free. */
function extractFunction(text: string, name: string): string {
  const code = stripComments(text)
  const start = code.search(new RegExp(`export (?:async )?function ${name}\\b`))
  return start === -1 ? '' : functionBodyFrom(code, start)
}

/** The route component itself: `export default [async] function …`. */
function extractDefaultFunction(text: string): string {
  const code = stripComments(text)
  const start = code.search(/export default (?:async )?function\b/)
  return start === -1 ? '' : functionBodyFrom(code, start)
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

/**
 * Reads that expose private-marketplace inventory.
 *
 * The guard must run before any of these, in the route component and in
 * `generateMetadata` alike — a title leaking a product name is still a leak.
 */
const CATALOG_READS = [
  'listProducts(',
  'listFeaturedProducts(',
  'listCategoriesWithCounts(',
  'listActiveBrands(',
  'getProductBySlug(',
  'getCategoryBySlug(',
]

/** Index of the first catalogue read in `body`, or -1. */
function firstCatalogRead(body: string): number {
  const hits = CATALOG_READS.map((name) => body.indexOf(name)).filter((at) => at >= 0)
  return hits.length === 0 ? -1 : Math.min(...hits)
}

/**
 * The rendered nav tag — `<SiteNav …/>` or `<CustomerSiteNav …/>` — or ''.
 *
 * `CustomerSiteNav` is the Server Component wrapper the customer pages render.
 * It resolves the viewer and their unread notification count and then renders
 * `SiteNav`, FORWARDING `marketplaceEntry` UNCHANGED — it makes no membership
 * decision of its own, which is asserted directly further down rather than
 * assumed here.
 *
 * Both spellings are accepted so that the assertions below keep reading the
 * attribute the page actually passes. Widening the match does not widen what is
 * allowed: every check that consumes this tag still demands the same
 * `marketplaceEntry` value it demanded before, from the same call sites.
 */
function siteNavTag(body: string): string {
  return body.match(/<(?:Customer)?SiteNav\b[^>]*\/>/)?.[0] ?? ''
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

  console.log('\n-- the guard is wired to EXACTLY three routes -----------')

  /*
   * The load-bearing section, and exact in BOTH directions.
   *
   * Enforcement is on. `marketplace_access` decides who reaches private
   * inventory, so a fourth call site is an unreviewed extension of the boundary
   * and a missing call on one of the three is a hole in it — this check refuses
   * both rather than only the direction that looks like tightening.
   *
   * Counted from `codeOnly()`: comments gone, `'…'` and "…" blanked. The DAL
   * block comment describes this guard at length, `lib/marketplace/access.ts`
   * names it in prose, and this very file quotes it — none of that is a call.
   * What counts is the name followed by whitespace and `(`.
   */
  const definitionFiles = new Set([
    join('lib', 'auth', 'dal.ts'),
    join('scripts', 'verify-marketplace-access.ts'),
  ])

  const GUARDED_ROUTES = [
    join('app', 'shop', 'page.tsx'),
    join('app', 'shop', '[category]', 'page.tsx'),
    join('app', 'product', '[slug]', 'page.tsx'),
  ]

  const files = sourceFiles()
  assert(
    'the tree scan actually found files',
    files.length > 50,
    `only ${files.length} scanned — a scan that finds nothing passes everything`,
  )

  const guardCallSites: string[] = []
  const valueImporters: string[] = []
  const literalGrantSites: string[] = []

  for (const file of files) {
    const relativePath = relative(ROOT, file)
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

    /*
     * The DAL defines the guard and this file quotes it — in prose, in
     * assertion names and in the patterns below. Both are exempt from every
     * scan in this loop, because a check that reads its own source finds
     * whatever it was written to look for.
     */
    if (definitionFiles.has(relativePath)) continue

    if (callsGuard(text)) guardCallSites.push(relativePath)

    /*
     * A hard-coded `marketplaceEntry` grant hands out the shop link with no
     * decision behind it. Collected tree-wide, then required to be exactly the
     * three guarded routes — so a new page cannot quietly award itself entry.
     */
    if (/marketplaceEntry=(?:"granted"|'granted'|\{\s*'granted'\s*\})/.test(stripComments(text))) {
      literalGrantSites.push(relativePath)
    }

    /*
     * Type-only imports are not participation in the decision: a route that
     * imports `MarketplaceAccessDecision` to name a variable has resolved
     * nothing. A value import is the thing to notice.
     */
    for (const statement of stripComments(text).matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      if (!/lib\/marketplace\/access$/.test(statement[3])) continue
      if (statement[1]) continue
      const specifiers = statement[2]
        .split(',')
        .map((specifier) => specifier.trim())
        .filter(Boolean)
      if (specifiers.some((specifier) => !specifier.startsWith('type '))) {
        valueImporters.push(relativePath)
      }
    }
  }

  check(
    'requireMarketplaceAccess is invoked by exactly the three private routes',
    [...guardCallSites].sort(),
    [...GUARDED_ROUTES].sort(),
  )
  check(
    'and marketplaceEntry="granted" is passed from exactly those same three',
    [...literalGrantSites].sort(),
    [...GUARDED_ROUTES].sort(),
  )
  assert(
    'the resolver is imported for VALUE by nothing but the DAL and this file',
    valueImporters.length === 0,
    `imported by: ${valueImporters.join(', ')}`,
  )

  /*
   * Named explicitly as well as covered by the equality above. These are the
   * paths the acceptance criteria call out, and naming them means the report
   * says which boundary held rather than only that some set matched.
   */
  for (const [label, segments] of [
    ['the homepage', ['app', 'page.tsx']],
    ['the gate', ['app', 'gate', 'page.tsx']],
    ['the site nav', ['components', 'site-nav.tsx']],
  ] as const) {
    const path = join(...segments)
    assert(
      `${label} does not invoke the guard`,
      !guardCallSites.includes(path),
      `${path} calls requireMarketplaceAccess() — that boundary belongs to the route, not here`,
    )
  }

  const strayCallSites = guardCallSites.filter((path) => !GUARDED_ROUTES.includes(path))
  for (const [label, segments] of [
    ['app routes and pages', ['app']],
    ['components', ['components']],
    ['the proxy', ['proxy.ts']],
    ['catalog queries', ['lib', 'catalog']],
    ['auth actions (sign-up)', ['lib', 'auth', 'actions.ts']],
  ] as const) {
    const prefix = join(...segments)
    const hits = strayCallSites.filter(
      (path) => path === prefix || path.startsWith(prefix + sep),
    )
    assert(`no unapproved call sites in ${label}`, hits.length === 0, hits.join(', '))
  }

  console.log('\n-- private routes guard BEFORE they read ----------------')

  /*
   * Order is the whole assertion. A guard that runs after the query has already
   * read the catalogue is a guard on the RESPONSE, not on the data — the rows
   * were fetched, and only the rendering was refused.
   *
   * `generateMetadata` is checked separately and to the same standard: Next runs
   * it independently of the component, so a product name in a <title> escapes a
   * guard that only exists in the body.
   */
  for (const route of [
    { label: 'app/shop', segments: ['app', 'shop', 'page.tsx'], metadata: false },
    {
      label: 'app/shop/[category]',
      segments: ['app', 'shop', '[category]', 'page.tsx'],
      metadata: true,
    },
    {
      label: 'app/product/[slug]',
      segments: ['app', 'product', '[slug]', 'page.tsx'],
      metadata: true,
    },
  ] as const) {
    const routeSource = stripComments(source(...route.segments))
    const body = extractDefaultFunction(routeSource)

    assert(`${route.label}: the route component was found`, body.length > 0)

    const guardAt = body.search(GUARD_CALL)
    const readAt = firstCatalogRead(body)
    assert(
      `${route.label}: awaits requireMarketplaceAccess()`,
      /await\s+requireMarketplaceAccess\s*\(/.test(body),
      'an unawaited guard rejects a promise instead of refusing a request',
    )
    assert(
      `${route.label}: guards BEFORE the first catalogue read`,
      guardAt >= 0 && readAt >= 0 && guardAt < readAt,
      `guard at ${guardAt}, first catalogue read at ${readAt}`,
    )

    const tag = siteNavTag(body)
    const tagAt = body.indexOf(tag)
    assert(
      `${route.label}: passes marketplaceEntry="granted" to SiteNav`,
      tag.length > 0 &&
        /marketplaceEntry=(?:"granted"|'granted'|\{\s*'granted'\s*\})/.test(tag),
      `SiteNav tag: ${tag || '(not found)'}`,
    )
    assert(
      `${route.label}: and only AFTER the guard has admitted the request`,
      guardAt >= 0 && tagAt > guardAt,
      `guard at ${guardAt}, <SiteNav> at ${tagAt}`,
    )

    if (!route.metadata) continue

    const metadataBody = extractFunction(routeSource, 'generateMetadata')
    const metadataGuardAt = metadataBody.search(GUARD_CALL)
    const metadataReadAt = firstCatalogRead(metadataBody)
    assert(`${route.label}: generateMetadata() was found`, metadataBody.length > 0)
    assert(
      `${route.label}: generateMetadata guards before it reads`,
      metadataGuardAt >= 0 && metadataReadAt >= 0 && metadataGuardAt < metadataReadAt,
      `guard at ${metadataGuardAt}, read at ${metadataReadAt}`,
    )
  }

  console.log('\n-- the homepage probes, it does not enforce -------------')

  /*
   * `/` stays public: it must NOT throw a 403 at a signed-out visitor, so it
   * asks the silent probe rather than the guard. What it may not do is show
   * private inventory while it is at it — the catalogue reads sit behind the
   * granted branch, and the nav link it passes down is derived from the same
   * decision rather than asserted.
   */
  const homeCode = stripComments(source('app', 'page.tsx'))
  const homeBody = extractDefaultFunction(homeCode)

  assert('the homepage component was found', homeBody.length > 0)
  assert(
    'the homepage asks getMarketplaceAccess() — the probe, not the guard',
    /getMarketplaceAccess\s*\(/.test(homeBody) && !GUARD_CALL.test(codeOnly(homeBody)),
    'requireMarketplaceAccess() here would 403 the front door',
  )
  {
    /*
     * `\bgranted\b` rather than `.granted`, so destructuring the decision reads
     * the same as reaching into it. Both are the same claim: the branch is
     * tested before the catalogue is touched.
     */
    const grantedAt = homeBody.search(/\bgranted\b/)
    const readAt = firstCatalogRead(homeBody)
    assert(
      'and reads the private catalogue only behind the granted branch',
      grantedAt >= 0 && readAt >= 0 && grantedAt < readAt,
      `granted test at ${grantedAt}, first catalogue read at ${readAt}`,
    )
  }
  {
    /*
     * The homepage may pass the nav entry or omit it — omitting it points the
     * link at the gate, which is the honest answer for a visitor it knows
     * nothing about. What it may NOT do is assert one. The value has to be an
     * expression carrying the decision, either inline or through a local bound
     * to it; a bare `"granted"` attribute is a grant with nothing behind it and
     * is caught tree-wide above as well.
     */
    const tag = siteNavTag(homeBody)
    const passesEntry = tag.includes('marketplaceEntry')
    const expression = tag.match(/marketplaceEntry=\{([^}]*)\}/)?.[1]?.trim() ?? ''
    const derived =
      /\bgranted\b/.test(expression) ||
      (/^[A-Za-z_$][\w$]*$/.test(expression) &&
        new RegExp(`\\bconst\\s+${expression}\\s*=[\\s\\S]{0,200}?granted`).test(homeBody))

    assert(
      'the homepage nav entry, if passed at all, is derived from the probe decision',
      !passesEntry || derived,
      `SiteNav tag: ${tag || '(not found)'} — a literal here would be a grant with no decision`,
    )
  }

  console.log('\n-- SiteNav: the shop link is EARNED ---------------------')

  const navCode = stripComments(source('components', 'site-nav.tsx'))

  /*
   * Link constants resolved BY VALUE, not by name. The component may call them
   * whatever it likes; what this section proves is where each one points.
   */
  const linkConstants = navStringConstants(navCode)
  const objectLinkConstants = navHrefObjectConstants(navCode)

  function linkTarget(expression: string): string | null {
    const expr = expression.trim().replace(/\s+as\s+[\w$.<>[\]]+$/, '')
    const literal = expr.match(/^(['"])([^'"]*)\1$/)

    if (literal) return literal[2]

    const reference = expr.match(/^([A-Za-z_$][\w$]*)(\.href)?$/)
    if (!reference) return null

    if (reference[2]) {
      return objectLinkConstants.get(reference[1])?.value ?? null
    }

    return (
      objectLinkConstants.get(reference[1])?.value ??
      linkConstants.get(reference[1])?.value ??
      null
    )
  }

  /*
   * The selector, matched STRUCTURALLY rather than by variable name.
   *
   * The comparison may be written against a parameter called anything at all —
   * `entry`, `value`, the prop itself. Requiring a particular identifier would
   * be checking a spelling, and a rename would "fail" a component whose
   * semantics never moved. What must hold is the shape: an exact `===` against
   * the literal `'granted'`, the shop link on the true arm, the gate on the
   * other, and the compared value traceable to the prop.
   */
  const selector = navCode.match(
    /([A-Za-z_$][\w$]*)\s*===\s*(['"])granted\2\s*\?\s*([^?:]+?)\s*:\s*([^\n;,)}]+)/,
  )

  assert(
    'SiteNav selects its marketplace link with an exact === granted test',
    selector !== null,
    'no `<identifier> === \'granted\' ? … : …` found — the link is chosen some other way',
  )

  const comparedIdentifier = selector?.[1] ?? ''
  check(
    'only the exact literal granted reaches the shop',
    selector ? linkTarget(selector[3]) : null,
    '/shop',
  )
  check(
    'and every other value — denied, unknown, omitted — reaches the gate',
    selector ? linkTarget(selector[4]) : null,
    '/gate',
  )

  {
    /*
     * The compared value has to come from the prop. Either it IS the prop, or
     * it is the parameter of a helper that the component calls WITH the prop —
     * which is what makes the name irrelevant and the wiring provable.
     */
    const helper = comparedIdentifier
      ? navCode.match(
          new RegExp(`function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*${comparedIdentifier}\\b[^)]*\\)`),
        )
      : null
    const fedByProp =
      comparedIdentifier === 'marketplaceEntry' ||
      (helper !== null &&
        new RegExp(`\\b${helper[1]}\\s*\\(\\s*marketplaceEntry\\s*\\)`).test(navCode))
    assert(
      'the compared value is the marketplaceEntry prop, whatever it is called locally',
      fedByProp,
      `compared identifier: ${comparedIdentifier || '(none)'} — it must trace to the prop`,
    )
  }

  assert(
    'the prop is optional, so an unwired caller omits it rather than forging it',
    /\bmarketplaceEntry\?\s*:/.test(navCode),
  )
  assert(
    'and it has no default, nullish or otherwise, that would manufacture a grant',
    !/marketplaceEntry\s*(?:=|\?\?|\|\|)\s*['"]granted['"]/.test(navCode) &&
      !/\(\s*marketplaceEntry\s*(?:\?\?|\|\|)/.test(navCode),
    'an omitted prop must fall through to the gate, not into the shop',
  )

  assert(
    'exactly one exact-equality test against granted exists',
    (navCode.match(/===\s*['"]granted['"]/g) ?? []).length === 1,
    'a second test is a second way in, and only one of them is checked here',
  )
  assert(
    'no inequality or loose comparison against granted',
    !/!==?\s*['"]granted['"]/.test(navCode) &&
      !/(?<![=!])==(?!=)\s*['"]granted['"]/.test(navCode),
    '`!== \'granted\'` inverts the default, and `==` admits anything that coerces',
  )
  assert(
    'no denial-shaped comparison decides the link',
    !/[!=]==?\s*['"](?:denied|suspended|revoked|no_membership|not_signed_in|membership_suspended|membership_revoked|unrecognized_membership)['"]/.test(
      navCode,
    ),
    'testing for denial makes every unenumerated value a grant',
  )
  if (comparedIdentifier) {
    assert(
      'and the entry value is never used as a truthiness test',
      /* `?(?!\.|\s*:)` so `entry?.x` and an optional `entry?:` stay legal. */
      !new RegExp(`\\b${comparedIdentifier}\\s*\\?(?!\\.|\\s*:)`).test(navCode) &&
        !new RegExp(`!\\s*${comparedIdentifier}\\b`).test(navCode) &&
        !new RegExp(`if\\s*\\(\\s*!?\\s*${comparedIdentifier}\\s*\\)`).test(navCode) &&
        !/!\s*marketplaceEntry\b/.test(navCode) &&
        !/\bmarketplaceEntry\s*\?(?!\.|\s*:)/.test(navCode) &&
        !/Boolean\(\s*marketplaceEntry/.test(navCode),
      'any non-empty string is truthy — `\'denied\'` would open the shop',
    )
  }

  {
    /*
     * The ONLY route to `/shop` in this component is the true arm above.
     *
     * Every mention of the shop target — the literal, or any constant bound to
     * it — must sit inside its own declaration or inside that ternary. A static
     * nav entry, a `?? SHOP_LINK` fallback, a second conditional: all of them
     * land outside those spans and are reported here. This is what makes the
     * single selector check above a complete argument rather than a sample.
     */
    const shopIdentifiers = [
      ...[...linkConstants.entries()]
        .filter(([, target]) => target.value === '/shop')
        .map(([name]) => name),
      ...[...objectLinkConstants.entries()]
        .filter(([, target]) => target.value === '/shop')
        .map(([name]) => name),
    ].filter((name, index, all) => all.indexOf(name) === index)

    const allowedSpans: Array<[number, number]> = []

    /*
     * The selector itself is the proven authorized use.
     */
    if (selector?.index !== undefined) {
      allowedSpans.push([selector.index, selector.index + selector[0].length])
    }

    /*
     * If the granted arm uses a named constant, exempt ONLY:
     *   1. that constant's declaration name; and
     *   2. the exact /shop literal structurally resolved from it.
     *
     * A second /shop constant gets no exemption.
     * A second use of this constant gets no exemption.
     */
    const grantedExpression =
      selector?.[3]?.trim().replace(/\s+as\s+[\w$.<>[\]]+$/, '') ?? ''

    const grantedReference =
      /^([A-Za-z_$][\w$]*)(?:\.href)?$/.exec(grantedExpression)?.[1] ?? null

    if (grantedReference !== null) {
      const provenTarget =
        objectLinkConstants.get(grantedReference) ??
        linkConstants.get(grantedReference) ??
        null

      if (provenTarget?.value === '/shop') {
        allowedSpans.push([provenTarget.start, provenTarget.end])

        const declaration = navCode.match(
          new RegExp(`\\bconst\\s+${grantedReference}\\b`),
        )

        if (declaration?.index !== undefined) {
          allowedSpans.push([
            declaration.index,
            declaration.index + declaration[0].length,
          ])
        }
      }
    }

    const pattern = new RegExp(
      ['\\/shop\\b', ...shopIdentifiers.map((name) => `\\b${name}\\b`)].join('|'),
      'g',
    )

    const stray: string[] = []

    for (const reference of navCode.matchAll(pattern)) {
      const at = reference.index ?? -1

      if (!allowedSpans.some(([from, to]) => at >= from && at < to)) {
        stray.push(`${reference[0]} @ ${at}`)
      }
    }

    assert(
      'the shop target appears nowhere but that one conditional',
      stray.length === 0,
      `stray references: ${stray.join(', ')} — a static /shop entry bypasses the test`,
    )
  }

  assert(
    'SiteNav resolves no membership of its own',
    !/from\s+['"][^'"]*lib\/(?:marketplace\/access|auth\/dal|db)/.test(navCode) &&
      !/\b(?:getMarketplaceAccess|requireMarketplaceAccess|resolveMarketplaceAccess|lookupMarketplaceMembership|getCurrentUser)\b/.test(
        navCode,
      ) &&
      !navCode.includes('fetch(') &&
      !/\bSessionUser\b/.test(navCode),
    'a client component deciding its own membership decides it in the browser',
  )

  console.log('\n-- the nav wrapper forwards, it does not decide ---------')

  /*
   * `CustomerSiteNav` sits between the customer pages and `SiteNav`. It exists
   * for the viewer and their unread notification count, and it is a Server
   * Component — which is exactly the position from which it COULD start
   * deciding membership, and must not.
   *
   * Everything proven about the ternary above is proven about `SiteNav`. That
   * argument only reaches the pages if the value they pass arrives unchanged,
   * so the forwarding is asserted here rather than taken on trust. A wrapper
   * that defaulted, coerced or invented `marketplaceEntry` would leave every
   * assertion in this file technically true and the shop link wrong.
   */
  const wrapperCode = stripComments(source('components', 'customer-site-nav.tsx'))

  assert('components/customer-site-nav.tsx was found', wrapperCode.length > 0)
  assert(
    'it forwards the marketplaceEntry prop through to SiteNav, unaltered',
    /<SiteNav\b[\s\S]*?marketplaceEntry=\{\s*marketplaceEntry\s*\}/.test(wrapperCode),
    'the value the page passed must be the value SiteNav tests',
  )
  assert(
    'and manufactures no entry of its own — no literal, no default, no fallback',
    !/['"]granted['"]/.test(wrapperCode) &&
      !/marketplaceEntry\s*(?:=|\?\?|\|\|)\s*['"]/.test(wrapperCode),
    'an omitted prop must still arrive omitted, so SiteNav falls through to the gate',
  )
  assert(
    'it resolves no membership: no probe, no guard, no resolver, no schema read',
    !/\b(?:getMarketplaceAccess|requireMarketplaceAccess|resolveMarketplaceAccess|lookupMarketplaceMembership)\b/.test(
      wrapperCode,
    ) && !/from\s+['"][^'"]*lib\/(?:marketplace\/access|db)/.test(wrapperCode),
    'membership belongs to the route that reads private data, not to the header',
  )
  assert(
    'and the shop target appears nowhere in it',
    !/\/shop\b/.test(wrapperCode),
    'a link built here would bypass the === granted test entirely',
  )

  console.log('\n-- untouched nav callers still reach the gate -----------')

  /*
   * The four pages that were never part of the membership slice. They pass no
   * `marketplaceEntry` — through the wrapper or, for `/design`, directly — so by
   * the ternary proven above they render `/gate`, which is the correct answer
   * for a page that has established nothing about the viewer. Named
   * individually because "we changed nothing there" is exactly the claim that
   * rots silently.
   */
  for (const segments of [
    ['app', 'design', 'page.tsx'],
    ['app', 'bag', 'page.tsx'],
    ['app', 'orders', '[number]', 'page.tsx'],
    ['app', 'checkout', 'review', 'page.tsx'],
  ] as const) {
    const path = join(...segments)
    const callerCode = stripComments(source(...segments))
    const tag = siteNavTag(callerCode)

    assert(`${path}: renders SiteNav`, tag.length > 0)
    assert(
      `${path}: passes no marketplaceEntry, so its Shop link is the gate`,
      tag.length > 0 && !tag.includes('marketplaceEntry'),
      `SiteNav tag: ${tag}`,
    )
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
