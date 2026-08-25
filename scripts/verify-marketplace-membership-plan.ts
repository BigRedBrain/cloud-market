/**
 * Marketplace membership grant planning — behaviour checks and safety guards.
 *
 * Run: npx tsx scripts/verify-marketplace-membership-plan.ts
 *
 * HERMETIC BY CONSTRUCTION. No database, no network, no `.env.local`, no
 * request scope, no child process. Every account below is invented: the ids are
 * hand-written UUIDs in a reserved-looking block and every address is under
 * `.invalid`, the TLD RFC 2606 sets aside precisely so that a fixture cannot
 * turn out to belong to somebody. `lib/marketplace/membership-grant-plan.ts`
 * has no imports at all — asserted here rather than assumed — so it loads in a
 * bare Node process and these are assertions about the real planner rather than
 * about a stand-in. `lib/db/schema` is imported for METADATA only, the way
 * `scripts/verify-marketplace-schema.ts` does: `getTableConfig` and `enumValues`
 * read drizzle's description of the tables and open no connection.
 *
 * WHAT THIS IS PROVING. Not that the code runs, but seven claims:
 *
 *   1. IDENTITY IS THE IMMUTABLE INTERNAL KEY. The manifest is keyed by
 *      `users.id` — the uuid primary key that `marketplace_access.user_id`
 *      references under a UNIQUE index — and by nothing else. An email address
 *      can block a plan and can never select or authorize an account.
 *   2. EVERY REFUSAL FAILS CLOSED. Missing account, mismatched address, scope
 *      conflict, suspension, revocation and an unreadable row all refuse, and
 *      one refusal makes the whole manifest inapplicable. Nothing is
 *      reactivated, no scope is changed, no account is created.
 *   3. MEMBERSHIP IS NEVER MANUFACTURED. Not from a role, not from an account
 *      status, not from being the owner, not from an order or a store. The
 *      snapshot the planner is handed has no field to carry any of it.
 *   4. A MANIFEST INSIDE THE REPOSITORY IS NEVER OPENED. Both the path as typed
 *      and the path after links are followed must be outside the root, and the
 *      refusal lands before the file is read, parsed or looked up.
 *   5. IDENTITY IS ESTABLISHED BEFORE MEMBERSHIP IS READ. An unknown id and a
 *      mismatched address are never the subject of a `marketplace_access`
 *      question, and when nothing is eligible that query is not issued at all.
 *   6. AN ADDRESS IS READ ONLY FOR THE ENTRY THAT ASKED FOR ONE. Existence and
 *      email verification are two queries over two different id lists, and the
 *      second list is exactly the entries carrying an `expectedEmail`. A
 *      manifest of twenty-five grants with one `expectedEmail` reads ONE stored
 *      address; a manifest with none reads no address and issues no such query.
 *   7. THE TOOLING CANNOT WRITE. The planner and the CLI are scanned for
 *      mutation primitives, mutation SQL, generated statements, apply/execute/
 *      force capability and account creation. `db` is reachable from the CLI —
 *      it has to be, to read — so the scan also pins the ONLY member of it that
 *      the CLI touches, and the exact columns it may project.
 *
 * THE SCAN READS AN AST, NOT A BLURRED COPY OF THE TEXT. An earlier version of
 * this file blanked quoted strings with a regular expression before looking for
 * mutation SQL, which meant the one place mutation SQL would actually be written
 * — inside a string — was the one place the scan could not see. Now every
 * scanned file is parsed with the repository's own TypeScript compiler
 * (`typescript` is already a devDependency; `createSourceFile` parses text and
 * opens nothing), and the two questions are asked of two different things:
 *
 *   · CAPABILITY is asked of the syntax tree — which members of `db` are
 *     touched, which methods are called, what is imported, what is declared.
 *     Prose in a comment cannot answer it, because comments are not nodes.
 *   · SQL TEXT is asked of every string and template literal, reassembled
 *     including the static parts of an interpolation. A generated statement is
 *     a string before it is a statement.
 *
 * THIS FILE IS NEVER SCANNED, AND SAYS SO OUT LOUD. It has to contain the
 * vocabulary it forbids — the fixtures below deliberately spell out `INSERT
 * INTO`, `db.insert(...)` and `--apply` — so an assertion at the end shows that
 * pointing the scanner at this file WOULD report findings, which is exactly why
 * the scan names the planner and the CLI and nothing else.
 *
 * SLICE 2A ENDS AT PLANNING. There is deliberately no check here that anything
 * was applied, because there is deliberately nothing that can apply it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { getTableConfig } from 'drizzle-orm/pg-core'
import ts from 'typescript'

import {
  marketplaceAccess,
  marketplaceAccessStatus,
  marketplaceScope,
  users,
} from '../lib/db/schema'
import {
  GRANT_PLAN_OUTCOMES,
  GRANT_SCOPES,
  MANIFEST_LOCATION_VERDICTS,
  MAX_MANIFEST_GRANTS,
  MEMBERSHIP_GRANT_MANIFEST_VERSION,
  MEMBERSHIP_STATUSES,
  USER_ID_PATTERN,
  attachMemberships,
  checkManifestLocation,
  formatPlanReport,
  isPathAtOrBeneath,
  normalizeEmailForComparison,
  parseGrantManifest,
  planMembershipGrants,
  planUserLookup,
  verifyIdentities,
  type AccountSnapshot,
  type GrantManifest,
  type GrantPlanOutcome,
  type GrantScope,
  type LiveUserRow,
  type ManifestLocationVerdict,
  type MembershipGrantPlan,
  type MembershipRow,
  type StoredEmailRow,
  type StoredMembershipRow,
} from '../lib/marketplace/membership-grant-plan'

const ROOT = join(__dirname, '..')

const PLAN_LIB = join('lib', 'marketplace', 'membership-grant-plan.ts')
const PLAN_CLI = join('scripts', 'plan-marketplace-memberships.ts')
const THIS_FILE = join('scripts', 'verify-marketplace-membership-plan.ts')

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

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

/** Comments removed, so structural checks read code and not prose about code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/* -------------------------------------------------------------------------- */
/* Reading a file the way the compiler reads it                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the guards below are allowed to know about one scanned file.
 *
 * All of it comes from the parse tree. The two text views are produced by
 * blanking RANGES the parser identified — not by a regular expression guessing
 * where a comment or a string ends, which is the mistake this replaces: a regex
 * that treats the `'` inside `/[^\s'"]+/` as the start of a string literal will
 * happily blank out the executable code that follows it.
 */
type SourceFacts = {
  label: string
  file: string
  raw: string
  /** Comments blanked, and the CONTENT of every string and template chunk too. */
  code: string
  /** Comments blanked, literals intact — for pins that quote an argument. */
  withoutComments: string
  /** Every statically knowable string, template and `+` concatenation. */
  texts: readonly string[]
  /** Module specifiers: static imports, dynamic imports and `require`. */
  imports: readonly string[]
  /** `specifier:name` for every named or default import binding. */
  importedNames: readonly string[]
  identifiers: readonly string[]
  /** `object.name` where the object is a plain identifier. */
  pairs: readonly string[]
  /** Every property name reached with a dot. */
  members: readonly string[]
  /** Property names in call position: `x.name(...)`. */
  calledMembers: readonly string[]
  /** Bare function names in call position: `name(...)`. */
  calledFunctions: readonly string[]
  /** `name` for every `db.name`. */
  dbMembers: readonly string[]
  /** True if anything reaches a member of `db` by computed name. */
  dynamicDbAccess: boolean
  /** The tag of every tagged template, e.g. the `sql` of ``sql`…` ``. */
  templateTags: readonly string[]
  declaredNames: readonly string[]
  hasAsync: boolean
  hasAwait: boolean
}

/**
 * The text of a literal, a template (with `EXPR` standing in for each hole), or
 * a concatenation of those. `null` when the value is not statically knowable.
 *
 * The `EXPR` placeholder is a word, deliberately: `UPDATE ${table} SET x` must
 * still read as an UPDATE ... SET to a scanner, because that is exactly what it
 * would read as to Postgres.
 */
function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text

  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => `EXPR${span.literal.text}`).join('')
    )
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left)
    const right = staticText(node.right)
    if (left !== null && right !== null) return left + right
  }

  return null
}

/** Ranges replaced by spaces, so every other offset in the file stays put. */
function blankRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const characters = text.split('')

  for (const [start, end] of ranges) {
    for (let index = Math.max(0, start); index < Math.min(characters.length, end); index += 1) {
      if (characters[index] !== '\n') characters[index] = ' '
    }
  }

  return characters.join('')
}

function analyze(label: string, file: string, raw: string): SourceFacts {
  const tree = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const commentRanges: Array<readonly [number, number]> = []
  const literalRanges: Array<readonly [number, number]> = []
  const seenComments = new Set<number>()

  const texts: string[] = []
  const imports: string[] = []
  const importedNames: string[] = []
  const identifiers: string[] = []
  const pairs: string[] = []
  const members: string[] = []
  const calledMembers: string[] = []
  const calledFunctions: string[] = []
  const dbMembers: string[] = []
  const templateTags: string[] = []
  const declaredNames: string[] = []
  let dynamicDbAccess = false
  let hasAsync = false
  let hasAwait = false

  /** The delimiters stay; what they enclose does not. */
  function blankInside(node: ts.Node) {
    const start = node.getStart(tree)
    const end = node.getEnd()
    if (end - start > 2) literalRanges.push([start + 1, end - 1])
  }

  function collect(node: ts.Node) {
    for (const range of ts.getLeadingCommentRanges(raw, node.getFullStart()) ?? []) {
      if (seenComments.has(range.pos)) continue
      seenComments.add(range.pos)
      commentRanges.push([range.pos, range.end])
    }

    const literal = staticText(node)
    if (literal !== null) texts.push(literal)

    if (ts.isStringLiteralLike(node)) blankInside(node)

    if (ts.isTemplateExpression(node)) {
      blankInside(node.head)
      for (const span of node.templateSpans) blankInside(span.literal)
    }

    if (ts.isIdentifier(node)) identifiers.push(node.text)

    if (ts.isPropertyAccessExpression(node)) {
      members.push(node.name.text)
      if (ts.isIdentifier(node.expression)) {
        pairs.push(`${node.expression.text}.${node.name.text}`)
        if (node.expression.text === 'db') dbMembers.push(node.name.text)
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'db'
    ) {
      dynamicDbAccess = true
    }

    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        calledMembers.push(node.expression.name.text)
      }
      const first = node.arguments.length > 0 ? staticText(node.arguments[0]) : null

      if (ts.isIdentifier(node.expression)) {
        calledFunctions.push(node.expression.text)
        if (node.expression.text === 'require') imports.push(first ?? '(computed require)')
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push(first ?? '(computed import)')
      }
    }

    if (ts.isImportDeclaration(node)) {
      const specifier = staticText(node.moduleSpecifier) ?? '(computed specifier)'
      imports.push(specifier)

      const clause = node.importClause
      if (clause?.name !== undefined) importedNames.push(`${specifier}:default`)

      const bindings = clause?.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        importedNames.push(`${specifier}:*`)
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importedNames.push(`${specifier}:${element.name.text}`)
        }
      }
    }

    if (ts.isImportEqualsDeclaration(node)) imports.push('(import-equals)')

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      imports.push(staticText(node.moduleSpecifier) ?? '(computed specifier)')
    }

    if (ts.isTaggedTemplateExpression(node)) templateTags.push(node.tag.getText(tree))

    if (node.kind === ts.SyntaxKind.AsyncKeyword) hasAsync = true
    if (ts.isAwaitExpression(node)) hasAwait = true
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) hasAwait = true

    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      declaredNames.push(node.name.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declaredNames.push(node.name.text)
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      declaredNames.push(node.name.text)
    }
  }

  function walk(node: ts.Node) {
    collect(node)
    for (const child of node.getChildren(tree)) walk(child)
  }

  walk(tree)

  return {
    label,
    file,
    raw,
    code: blankRanges(raw, [...commentRanges, ...literalRanges]),
    withoutComments: blankRanges(raw, commentRanges),
    texts,
    imports,
    importedNames,
    identifiers,
    pairs,
    members,
    calledMembers,
    calledFunctions,
    dbMembers,
    dynamicDbAccess,
    templateTags,
    declaredNames,
    hasAsync,
    hasAwait,
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort()
}

/* -------------------------------------------------------------------------- */
/* What a file is forbidden to be able to do                                   */
/* -------------------------------------------------------------------------- */

/** The only member of `db` a read-only tool has any business touching. */
const PERMITTED_DB_MEMBERS: readonly string[] = ['select']

/**
 * Method names that write, or that only exist to build a write.
 *
 * Checked against every property name reached with a dot, called or not: a
 * mutation builder held in a variable and invoked later is the same capability
 * as one invoked in place.
 */
const MUTATION_MEMBERS: readonly string[] = [
  'insert',
  'update',
  'delete',
  'upsert',
  'values',
  'set',
  'returning',
  'execute',
  'transaction',
  'onConflictDoNothing',
  'onConflictDoUpdate',
]

/**
 * Mutation SQL, asked of string and template TEXT rather than of code.
 *
 * A generated statement is a string before it is a statement, and the previous
 * version of this file could not see one: it blanked quoted text before
 * scanning, so `'INSERT INTO …'` looked like `''`. These patterns now run over
 * the reassembled text of every literal in the file, holes included.
 */
const MUTATION_SQL: ReadonlyArray<readonly [string, RegExp]> = [
  ['INSERT statement', /\binsert\s+into\b/i],
  ['UPDATE statement', /\bupdate\s+[\w".]+\s+set\b/i],
  ['DELETE statement', /\bdelete\s+from\b/i],
  ['MERGE statement', /\bmerge\s+into\b/i],
  ['TRUNCATE statement', /\btruncate\b/i],
  ['ALTER statement', /\balter\s+(?:table|type|column|sequence)\b/i],
  [
    'GRANT statement',
    /\bgrant\s+(?:all|select|insert|update|delete|usage|create|connect|references|trigger)\b/i,
  ],
  ['REVOKE statement', /\brevoke\s+(?:all|select|insert|update|delete|usage)\b/i],
  ['conflict clause', /\bon\s+conflict\b/i],
  ['DO UPDATE clause', /\bdo\s+update\b/i],
]

/** A capability flag, as it would have to be written to be typed at a shell. */
const APPLY_FLAG = /--?(?:apply|execute|force|write|commit|yes)\b/i

/** An entry point whose name is the capability. */
const APPLY_ENTRY_POINT =
  /^(?:apply|execute)(?:Plan|Grant|Grants|Membership|Memberships)$|^(?:grant|create|revoke|suspend|reactivate)Membership$/

type Finding = { rule: string; evidence: string }

function condense(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat
}

/**
 * Every prohibited capability the file can be shown to have.
 *
 * One function, four rules, so that the same question can be asked of the real
 * planner and CLI (which must answer with nothing) and of the deliberately
 * hostile fixtures at the end (which must answer with something). A guard that
 * has never been seen to fire is a guard nobody has tested.
 */
function findings(facts: SourceFacts): readonly Finding[] {
  const found: Finding[] = []
  const note = (rule: string, evidence: string) => found.push({ rule, evidence })

  for (const member of facts.dbMembers) {
    if (!PERMITTED_DB_MEMBERS.includes(member)) note('db-api', `db.${member}`)
  }
  if (facts.dynamicDbAccess) note('db-api', 'db[computed]')

  for (const member of MUTATION_MEMBERS) {
    if (facts.members.includes(member)) note('mutation-primitive', `.${member}`)
  }
  for (const name of [...facts.identifiers, ...facts.templateTags]) {
    if (/upsert/i.test(name)) note('mutation-primitive', name)
    if (/onconflict/i.test(name)) note('mutation-primitive', name)
    if (name === 'withUpdatedAt') note('mutation-primitive', name)
  }
  if (facts.templateTags.includes('sql') || facts.calledFunctions.includes('sql')) {
    note('mutation-primitive', 'raw sql template')
  }
  for (const module of facts.imports) {
    if (/drizzle-kit|drizzle-orm\/migrator/.test(module)) note('mutation-primitive', module)
  }

  for (const text of facts.texts) {
    for (const [label, pattern] of MUTATION_SQL) {
      if (pattern.test(text)) note('mutation-sql', `${label}: ${condense(text)}`)
    }
  }

  for (const text of facts.texts) {
    if (APPLY_FLAG.test(text)) note('apply-capability', condense(text))
  }
  for (const name of [...facts.declaredNames, ...facts.identifiers, ...facts.members]) {
    if (APPLY_ENTRY_POINT.test(name)) note('apply-capability', name)
    if (/force/i.test(name)) note('apply-capability', name)
    if (name === 'createInterface' || name === 'readline') note('apply-capability', name)
  }
  for (const module of facts.imports) {
    if (/readline|child_process/.test(module)) note('apply-capability', module)
  }

  return found
}

/** The findings for one rule, as one readable line. */
function evidenceFor(found: readonly Finding[], rule: string): string {
  return unique(found.filter((entry) => entry.rule === rule).map((entry) => entry.evidence)).join(
    ', ',
  )
}

/* -------------------------------------------------------------------------- */
/* Fixtures — invented identities only                                         */
/* -------------------------------------------------------------------------- */

/** A fabricated but well-formed `users.id`. `n` keeps them distinguishable. */
function fixtureId(n: number): string {
  return `f1c70000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/**
 * A fabricated address for fixture `n`.
 *
 * `.invalid` is the TLD RFC 2606 reserves precisely so that a fixture address
 * cannot turn out to belong to somebody. An assertion at the end of this file
 * holds every address here to that domain.
 */
function fixtureEmail(n: number): string {
  return `fixture.${n}@example.invalid`
}

const ID = {
  noRowShopper: fixtureId(1),
  noRowVendor: fixtureId(2),
  activeShopper: fixtureId(3),
  activeVendor: fixtureId(4),
  suspendedShopper: fixtureId(5),
  revokedVendor: fixtureId(6),
  unknownAccount: fixtureId(7),
  verified: fixtureId(8),
  mismatched: fixtureId(9),
  unreadableRow: fixtureId(10),
  ownerLike: fixtureId(11),
} as const

function membership(scope: string, status: string): MembershipRow {
  return { scope, status }
}

function snapshot(
  userId: string,
  email: string | null,
  row: MembershipRow | null,
): AccountSnapshot {
  return { userId, email, membership: row }
}

function accountsOf(...snapshots: readonly AccountSnapshot[]): ReadonlyMap<string, AccountSnapshot> {
  return new Map(snapshots.map((entry) => [entry.userId, entry] as const))
}

/** A manifest built by hand, for the paths that must work without the parser. */
function manifestOf(
  ...grants: ReadonlyArray<{ userId: string; scope: GrantScope; expectedEmail?: string }>
): GrantManifest {
  return {
    version: MEMBERSHIP_GRANT_MANIFEST_VERSION,
    grants: grants.map((grant) => ({
      userId: grant.userId,
      scope: grant.scope,
      expectedEmail: grant.expectedEmail === undefined ? null : grant.expectedEmail,
    })),
  }
}

/** Parses, asserting success, so a broken fixture fails loudly and early. */
function parsedOk(name: string, document: unknown): GrantManifest {
  const result = parseGrantManifest(document)
  assert(
    `${name}: parses`,
    result.ok,
    result.ok ? '' : result.issues.map((problem) => `${problem.path} ${problem.code}`).join('; '),
  )
  return result.ok ? result.manifest : manifestOf()
}

/** The issue codes a rejected document produced, sorted for comparison. */
function issueCodes(document: unknown): readonly string[] {
  const result = parseGrantManifest(document)
  return result.ok ? [] : [...result.issues.map((problem) => problem.code)].sort()
}

const outcomesSeen = new Set<GrantPlanOutcome>()

/** `outcome:disposition` for one entry of a single-entry plan. */
function verdict(plan: MembershipGrantPlan): string {
  const entry = plan.entries[0]
  if (entry === undefined) return '(no entries)'
  outcomesSeen.add(entry.outcome)
  return `${entry.outcome}:${entry.disposition}`
}

function planOne(
  request: { userId: string; scope: GrantScope; expectedEmail?: string },
  accounts: ReadonlyMap<string, AccountSnapshot>,
): MembershipGrantPlan {
  return planMembershipGrants(manifestOf(request), accounts)
}

/* -------------------------------------------------------------------------- */
/* A fake for the database, and the real decisions                             */
/* -------------------------------------------------------------------------- */

/**
 * A `users` row as the FIXTURE DATABASE holds it, before any projection.
 *
 * This is deliberately wider than anything the CLI is allowed to select: it
 * carries the stored address for every fixture account, so that "the address
 * was never read" is a claim about what the queries projected rather than about
 * what the fixture happened to contain. A fake that holds no addresses cannot
 * fail to leak one.
 */
type FixtureUserRow = {
  userId: string
  email: string | null
}

/** One query the adapter issued: what it selected, and which ids it named. */
type Query = {
  columns: readonly string[]
  ids: readonly string[]
}

/** What each stage was asked, what it projected, and what came back. */
type LookupTrace = {
  accounts: ReadonlyMap<string, AccountSnapshot>
  /** One entry per `users` query issued, in order. Empty means none was. */
  userQueries: readonly Query[]
  /** One entry per `marketplace_access` query issued. Empty means none was. */
  membershipQueries: readonly Query[]
  /**
   * EVERY STORED ADDRESS THE PROCESS WAS HANDED. The point of the whole slice:
   * an address that no entry asked about must not appear here, so a manifest of
   * twenty-five grants with one `expectedEmail` reads exactly one address.
   */
  emailsRead: readonly string[]
}

/**
 * The CLI's adapter with its three queries replaced by filters over fixture rows.
 *
 * THE FAKE SUPPLIES ROWS; THE REAL CODE MAKES EVERY DECISION. `planUserLookup`,
 * `verifyIdentities` and `attachMemberships` are the exported functions the CLI
 * itself calls, in the order the CLI calls them — an order pinned against the
 * CLI source further down, so this cannot quietly drift into being a model of
 * something the tool no longer does. Nothing here opens a connection, because
 * there is nothing here to open one with: the "database" is two arrays.
 *
 * THE PROJECTIONS ARE MODELLED, NOT ASSUMED. The existence pass drops `email`
 * from every row it returns, exactly as `select({ id: users.id })` does, and the
 * verification pass runs only over `request.emailVerificationUserIds`. The
 * projections the CLI actually writes are pinned separately, against its parse
 * tree, so the model and the tool are checked against each other.
 */
function fakeLookup(
  manifest: GrantManifest,
  liveRows: readonly FixtureUserRow[],
  storedRows: readonly StoredMembershipRow[],
): LookupTrace {
  const request = planUserLookup(manifest)

  if (request.userIds.length === 0) {
    return { accounts: new Map(), userQueries: [], membershipQueries: [], emailsRead: [] }
  }

  const userQueries: Query[] = []

  /* STAGE 1a — existence. Bounded by the manifest, projecting the id alone. */
  const existenceIds = [...request.userIds]
  userQueries.push({ columns: ['users.id'], ids: existenceIds })

  const liveUsers: LiveUserRow[] = liveRows
    .filter((row) => existenceIds.includes(row.userId))
    .map((row) => ({ userId: row.userId }))

  /* STAGE 1b — verification. Only if some entry asked, only for those ids. */
  const verificationIds = [...request.emailVerificationUserIds]
  const emailsRead: string[] = []
  let storedEmails: StoredEmailRow[] = []

  if (verificationIds.length > 0) {
    userQueries.push({ columns: ['users.id', 'users.email'], ids: verificationIds })

    storedEmails = liveRows
      .filter((row) => verificationIds.includes(row.userId))
      .map((row) => ({ userId: row.userId, email: row.email }))

    for (const row of storedEmails) {
      if (row.email !== null) emailsRead.push(row.email)
    }
  }

  const verified = verifyIdentities(manifest, liveUsers, storedEmails)

  if (verified.eligibleUserIds.length === 0) {
    return { accounts: verified.snapshots, userQueries, membershipQueries: [], emailsRead }
  }

  /* STAGE 2 — membership, for the eligible ids and no others. */
  const membershipQueries: Query[] = [
    {
      columns: ['marketplaceAccess.scope', 'marketplaceAccess.status', 'marketplaceAccess.userId'],
      ids: [...verified.eligibleUserIds],
    },
  ]
  const rows = storedRows.filter((row) => verified.eligibleUserIds.includes(row.userId))

  return {
    accounts: attachMemberships(verified, rows),
    userQueries,
    membershipQueries,
    emailsRead,
  }
}

/**
 * The projection of every `db.select({ … })` in a file, in source order.
 *
 * READ FROM THE PARSE TREE, for the same reason the capability scan is: a
 * comment describing a projection is not a projection, and a regex looking for
 * one cannot tell the difference. `createSourceFile` parses a string and opens
 * nothing.
 */
function selectProjections(file: string, raw: string): ReadonlyArray<readonly string[]> {
  const tree = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const projections: string[][] = []

  function columnsOf(node: ts.Node, into: string[]) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      into.push(`${node.expression.text}.${node.name.text}`)
    }
    node.forEachChild((child) => columnsOf(child, into))
  }

  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'select'
    ) {
      const columns: string[] = []
      const shape = node.arguments[0]
      if (shape !== undefined) columnsOf(shape, columns)
      projections.push([...columns].sort())
    }
    node.forEachChild(walk)
  }

  walk(tree)
  return projections
}

function main() {
  console.log('\n-- identity: the manifest key is users.id ---------------')

  /*
   * The whole design rests on this: the manifest names accounts by the
   * immutable internal primary key, which is exactly the column
   * `marketplace_access.user_id` references under a unique index. If either
   * side of that ever moves, every assertion below is about the wrong column.
   */
  const userColumns = getTableConfig(users).columns
  const idColumn = userColumns.find((column) => column.name === 'id')

  assert('users.id exists', idColumn !== undefined)
  check(
    'users.id is the primary key',
    (idColumn as { primary?: boolean } | undefined)?.primary,
    true,
  )
  check('users.id is a uuid', idColumn?.getSQLType(), 'uuid')

  const accessConfig = getTableConfig(marketplaceAccess)
  const userIdColumn = accessConfig.columns.find((column) => column.name === 'user_id')

  assert('marketplace_access.user_id exists', userIdColumn !== undefined)
  check('marketplace_access.user_id is a uuid', userIdColumn?.getSQLType(), 'uuid')
  check('and is not null', userIdColumn?.notNull, true)

  {
    const referencedTables = accessConfig.foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable).name,
    )
    const referencedColumns = accessConfig.foreignKeys.flatMap((fk) =>
      fk.reference().foreignColumns.map((column) => column.name),
    )

    check('user_id references exactly one table', referencedTables.sort(), ['users'])
    check(
      'and that column is users.id — the manifest identity',
      referencedColumns.sort(),
      ['id'],
    )
  }

  {
    /*
     * ONE MEMBERSHIP PER ACCOUNT, enforced by the database. It is why a
     * duplicate id in a manifest is a validation error rather than something to
     * de-duplicate quietly, and why "grant a second row for the other scope" is
     * not an outcome this planner can produce.
     */
    const unique = accessConfig.indexes.filter((entry) => entry.config.unique === true)
    check(
      'exactly one unique index on marketplace_access',
      unique.map((entry) => entry.config.name),
      ['marketplace_access_user_unique'],
    )
    check(
      'and it is on user_id alone',
      (unique[0]?.config.columns as { name?: string }[] | undefined)?.map(
        (column) => column.name ?? '?',
      ),
      ['user_id'],
    )
  }

  assert(
    'USER_ID_PATTERN accepts a canonical uuid',
    USER_ID_PATTERN.test('9f8c4d2e-1b3a-4c5d-8e7f-0a1b2c3d4e5f'),
  )
  for (const malformed of [
    '',
    '   ',
    'not-a-uuid',
    '9f8c4d2e1b3a4c5d8e7f0a1b2c3d4e5f',
    '{9f8c4d2e-1b3a-4c5d-8e7f-0a1b2c3d4e5f}',
    'urn:uuid:9f8c4d2e-1b3a-4c5d-8e7f-0a1b2c3d4e5f',
    '9f8c4d2e-1b3a-4c5d-8e7f-0a1b2c3d4e5f ',
    '9f8c4d2e-1b3a-4c5d-8e7f-0a1b2c3d4e5g',
    '1',
  ]) {
    assert(
      `USER_ID_PATTERN rejects ${JSON.stringify(malformed)}`,
      !USER_ID_PATTERN.test(malformed),
    )
  }

  console.log('\n-- vocabulary matches the pg enums ----------------------')

  check(
    'GRANT_SCOPES equals marketplace_scope, in order',
    [...GRANT_SCOPES],
    [...marketplaceScope.enumValues],
  )
  check(
    'MEMBERSHIP_STATUSES equals marketplace_access_status, in order',
    [...MEMBERSHIP_STATUSES],
    [...marketplaceAccessStatus.enumValues],
  )
  check('the manifest version is exactly 1', MEMBERSHIP_GRANT_MANIFEST_VERSION, 1)
  check('the manifest ceiling is 25 grants', MAX_MANIFEST_GRANTS, 25)

  console.log('\n-- email is verification metadata, not identity ---------')

  /*
   * The comparison policy is trim-then-lower-case, restated in the planner
   * because it takes no dependencies. That restatement is only safe while it
   * matches the repository's own normalisation, so the shared `email` schema is
   * pinned here: if `lib/auth/validation.ts` ever stops doing exactly these two
   * steps before an address reaches `users_email_unique`, this fails.
   */
  const validationCode = stripComments(source(join('lib', 'auth', 'validation.ts')))
  const emailSchema = validationCode.slice(
    validationCode.indexOf('const email ='),
    validationCode.indexOf('const password ='),
  )
  assert('the shared email schema was found', emailSchema.length > 0)
  assert(
    'and still normalises by trim() then toLowerCase()',
    emailSchema.includes('.trim()') && emailSchema.includes('.toLowerCase()'),
    'the planner mirrors this policy; a change here must be mirrored there',
  )
  check(
    'normalizeEmailForComparison applies exactly those two steps',
    normalizeEmailForComparison('  Person.Name@Example.INVALID '),
    'person.name@example.invalid',
  )
  check(
    'and does NOT strip dots or +tags — two stored addresses stay two addresses',
    [
      normalizeEmailForComparison('a.b@example.invalid'),
      normalizeEmailForComparison('a+tag@example.invalid'),
    ],
    ['a.b@example.invalid', 'a+tag@example.invalid'],
  )

  console.log('\n-- manifest validation: the happy paths -----------------')

  {
    const manifest = parsedOk('minimal shopper manifest', {
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper' }],
    })
    check('one grant, expectedEmail defaults to null', [...manifest.grants], [
      { userId: ID.noRowShopper, scope: 'shopper', expectedEmail: null },
    ])
  }

  {
    const manifest = parsedOk('empty manifest', { version: 1, grants: [] })
    const plan = planMembershipGrants(manifest, accountsOf())
    check('an empty grants array is VALID', manifest.grants.length, 0)
    check('and plans zero changes', plan.entries.length, 0)
    check('and is applicable, vacuously', plan.applicable, true)
    check(
      'with every counter at zero',
      [plan.wouldGrantCount, plan.noChangeCount, plan.blockedCount],
      [0, 0, 0],
    )
  }

  {
    const manifest = parsedOk('mixed-case id and padded email', {
      version: 1,
      grants: [
        {
          userId: ID.verified.toUpperCase(),
          scope: 'vendor',
          expectedEmail: '  Fixture.Eight@Example.INVALID  ',
        },
      ],
    })
    check(
      'ids are lower-cased and addresses normalised at parse time',
      [...manifest.grants],
      [
        {
          userId: ID.verified,
          scope: 'vendor',
          expectedEmail: 'fixture.eight@example.invalid',
        },
      ],
    )
  }

  {
    const grants = Array.from({ length: MAX_MANIFEST_GRANTS }, (_unused, index) => ({
      userId: fixtureId(100 + index),
      scope: index % 2 === 0 ? 'shopper' : 'vendor',
    }))
    const manifest = parsedOk(`exactly ${MAX_MANIFEST_GRANTS} grants`, { version: 1, grants })
    check('the ceiling itself is allowed', manifest.grants.length, MAX_MANIFEST_GRANTS)
  }

  console.log('\n-- manifest validation: refusals ------------------------')

  check('a non-object document is refused', issueCodes(42), ['not_an_object'])
  check('null is refused', issueCodes(null), ['not_an_object'])
  check('an array is refused', issueCodes([{ userId: ID.noRowShopper, scope: 'shopper' }]), [
    'not_an_object',
  ])
  check(
    'a bare grants array with no version is refused',
    issueCodes({ grants: [] }),
    ['unsupported_version'],
  )
  check('version 0 is refused', issueCodes({ version: 0, grants: [] }), ['unsupported_version'])
  check('version 2 is refused', issueCodes({ version: 2, grants: [] }), ['unsupported_version'])
  check(
    'the STRING "1" is refused — exact, not coerced',
    issueCodes({ version: '1', grants: [] }),
    ['unsupported_version'],
  )
  check(
    'a missing grants array is refused',
    issueCodes({ version: 1 }),
    ['grants_not_an_array'],
  )
  check(
    'grants as an object is refused',
    issueCodes({ version: 1, grants: {} }),
    ['grants_not_an_array'],
  )

  check(
    'an unknown TOP-LEVEL field is refused, not ignored',
    issueCodes({ version: 1, grants: [], environment: 'production', force: true }),
    ['unknown_field', 'unknown_field'],
  )
  check(
    'an unknown GRANT field is refused, not ignored',
    issueCodes({
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper', status: 'active' }],
    }),
    ['unknown_field'],
  )
  check(
    'including one that looks like an authorization',
    issueCodes({
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper', grantedBy: 'owner' }],
    }),
    ['unknown_field'],
  )

  check(
    'a missing userId is refused',
    issueCodes({ version: 1, grants: [{ scope: 'shopper' }] }),
    ['missing_user_id'],
  )
  check(
    'a non-string userId is refused',
    issueCodes({ version: 1, grants: [{ userId: 7, scope: 'shopper' }] }),
    ['missing_user_id'],
  )
  check(
    'a blank userId is refused',
    issueCodes({ version: 1, grants: [{ userId: '   ', scope: 'shopper' }] }),
    ['blank_user_id'],
  )
  check(
    'a malformed userId is refused',
    issueCodes({ version: 1, grants: [{ userId: 'customer-42', scope: 'shopper' }] }),
    ['malformed_user_id'],
  )
  check(
    'an email in the userId slot is refused — identity is never an address',
    issueCodes({
      version: 1,
      grants: [{ userId: 'fixture.eight@example.invalid', scope: 'shopper' }],
    }),
    ['malformed_user_id'],
  )

  check(
    'a duplicate userId is refused',
    issueCodes({
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.noRowShopper, scope: 'shopper' },
      ],
    }),
    ['duplicate_user_id'],
  )
  check(
    'and a case-variant duplicate is still a duplicate',
    issueCodes({
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.noRowShopper.toUpperCase(), scope: 'vendor' },
      ],
    }),
    ['duplicate_user_id'],
  )

  check(
    'a missing scope is refused — there is no default scope',
    issueCodes({ version: 1, grants: [{ userId: ID.noRowShopper }] }),
    ['missing_scope'],
  )
  for (const scope of ['admin', 'owner', 'seller', 'customer', 'staff', 'SHOPPER', '']) {
    check(
      `scope ${JSON.stringify(scope)} is refused`,
      issueCodes({ version: 1, grants: [{ userId: ID.noRowShopper, scope }] }),
      ['unknown_scope'],
    )
  }

  check(
    'a null expectedEmail is refused — omit the field instead',
    issueCodes({
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper', expectedEmail: null }],
    }),
    ['malformed_expected_email'],
  )
  check(
    'a blank expectedEmail is refused',
    issueCodes({
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper', expectedEmail: '  ' }],
    }),
    ['malformed_expected_email'],
  )
  check(
    'a nonsense expectedEmail is refused',
    issueCodes({
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper', expectedEmail: 'not an address' }],
    }),
    ['malformed_expected_email'],
  )

  {
    const oversized = Array.from({ length: MAX_MANIFEST_GRANTS + 1 }, (_unused, index) => ({
      userId: fixtureId(200 + index),
      scope: 'shopper',
    }))
    check(
      `${MAX_MANIFEST_GRANTS + 1} grants is refused`,
      issueCodes({ version: 1, grants: oversized }),
      ['too_many_grants'],
    )
  }

  {
    /*
     * Exhaustive, not first-error. An operator fixing a hand-written list one
     * error per run stops reading carefully by the third attempt.
     */
    const document = {
      version: 3,
      extra: true,
      grants: [
        { userId: 'nope', scope: 'shopper' },
        { userId: ID.noRowShopper, scope: 'admin' },
        { userId: ID.noRowVendor, scope: 'vendor', force: true },
      ],
    }
    check(
      'every problem in one document is reported at once',
      issueCodes(document),
      ['unknown_field', 'unknown_field', 'unknown_scope', 'malformed_user_id', 'unsupported_version'].sort(),
    )
    check(
      'and validation is deterministic across runs',
      JSON.stringify(parseGrantManifest(document)),
      JSON.stringify(parseGrantManifest(document)),
    )
  }

  console.log('\n-- planning: the two harmless outcomes ------------------')

  check(
    'a shopper with no membership row plans a new active membership',
    verdict(planOne({ userId: ID.noRowShopper, scope: 'shopper' }, accountsOf(
      snapshot(ID.noRowShopper, null, null),
    ))),
    'grant_new_active:would_grant',
  )
  check(
    'a vendor with no membership row plans a new active membership',
    verdict(planOne({ userId: ID.noRowVendor, scope: 'vendor' }, accountsOf(
      snapshot(ID.noRowVendor, null, null),
    ))),
    'grant_new_active:would_grant',
  )
  check(
    'an identical active shopper membership is a deterministic no-op',
    verdict(planOne({ userId: ID.activeShopper, scope: 'shopper' }, accountsOf(
      snapshot(ID.activeShopper, null, membership('shopper', 'active')),
    ))),
    'already_active_same_scope:no_change',
  )
  check(
    'an identical active vendor membership is a deterministic no-op',
    verdict(planOne({ userId: ID.activeVendor, scope: 'vendor' }, accountsOf(
      snapshot(ID.activeVendor, null, membership('vendor', 'active')),
    ))),
    'already_active_same_scope:no_change',
  )

  {
    /* Idempotence: planning the same manifest twice says the same thing. */
    const manifest = manifestOf({ userId: ID.activeShopper, scope: 'shopper' })
    const accounts = accountsOf(snapshot(ID.activeShopper, null, membership('shopper', 'active')))
    check(
      're-planning an already-satisfied manifest changes nothing',
      JSON.stringify(planMembershipGrants(manifest, accounts)),
      JSON.stringify(planMembershipGrants(manifest, accounts)),
    )
  }

  console.log('\n-- planning: every refusal fails closed -----------------')

  check(
    'an unknown account is refused, never created',
    verdict(planOne({ userId: ID.unknownAccount, scope: 'shopper' }, accountsOf())),
    'user_not_found:blocked',
  )
  check(
    'a snapshot for a DIFFERENT id is refused too',
    verdict(
      planOne(
        { userId: ID.unknownAccount, scope: 'shopper' },
        new Map([[ID.unknownAccount, snapshot(ID.activeShopper, null, null)]]),
      ),
    ),
    'user_not_found:blocked',
  )

  check(
    'a mismatched expectedEmail is refused',
    verdict(
      planOne(
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
        accountsOf(snapshot(ID.mismatched, 'someone.else@example.invalid', null)),
      ),
    ),
    'expected_email_mismatch:blocked',
  )
  check(
    'and so is a verification with no address to verify against',
    verdict(
      planOne(
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
        accountsOf(snapshot(ID.mismatched, null, null)),
      ),
    ),
    'expected_email_mismatch:blocked',
  )
  check(
    'a matching expectedEmail, differing only in case and padding, verifies',
    verdict(
      planOne(
        { userId: ID.verified, scope: 'shopper', expectedEmail: 'fixture.eight@example.invalid' },
        accountsOf(snapshot(ID.verified, '  Fixture.Eight@Example.Invalid ', null)),
      ),
    ),
    'grant_new_active:would_grant',
  )
  check(
    'a verified address does NOT rescue a suspended membership',
    verdict(
      planOne(
        {
          userId: ID.suspendedShopper,
          scope: 'shopper',
          expectedEmail: 'fixture.five@example.invalid',
        },
        accountsOf(
          snapshot(
            ID.suspendedShopper,
            'fixture.five@example.invalid',
            membership('shopper', 'suspended'),
          ),
        ),
      ),
    ),
    'membership_suspended:blocked',
  )

  for (const scope of GRANT_SCOPES) {
    check(
      `a suspended ${scope} membership is refused, never reactivated`,
      verdict(
        planOne(
          { userId: ID.suspendedShopper, scope },
          accountsOf(snapshot(ID.suspendedShopper, null, membership(scope, 'suspended'))),
        ),
      ),
      'membership_suspended:blocked',
    )
    check(
      `a revoked ${scope} membership is refused, never reactivated`,
      verdict(
        planOne(
          { userId: ID.revokedVendor, scope },
          accountsOf(snapshot(ID.revokedVendor, null, membership(scope, 'revoked'))),
        ),
      ),
      'membership_revoked:blocked',
    )
  }

  check(
    'an active shopper asked to become a vendor is refused — no automatic upgrade',
    verdict(
      planOne(
        { userId: ID.activeShopper, scope: 'vendor' },
        accountsOf(snapshot(ID.activeShopper, null, membership('shopper', 'active'))),
      ),
    ),
    'scope_conflict:blocked',
  )
  check(
    'an active vendor asked to become a shopper is refused — no automatic downgrade',
    verdict(
      planOne(
        { userId: ID.activeVendor, scope: 'shopper' },
        accountsOf(snapshot(ID.activeVendor, null, membership('vendor', 'active'))),
      ),
    ),
    'scope_conflict:blocked',
  )

  /*
   * Postgres cannot remove an enum value but it can gain one. A build older
   * than its database will read scopes and statuses it has never heard of, and
   * the answer to an unreadable row is refusal, not a generous interpretation.
   */
  check(
    'an unrecognised stored SCOPE is refused',
    verdict(
      planOne(
        { userId: ID.unreadableRow, scope: 'shopper' },
        accountsOf(snapshot(ID.unreadableRow, null, membership('operator', 'active'))),
      ),
    ),
    'unrecognized_membership:blocked',
  )
  check(
    'an unrecognised stored STATUS is refused',
    verdict(
      planOne(
        { userId: ID.unreadableRow, scope: 'shopper' },
        accountsOf(snapshot(ID.unreadableRow, null, membership('shopper', 'pending'))),
      ),
    ),
    'unrecognized_membership:blocked',
  )

  console.log('\n-- membership is never manufactured --------------------')

  {
    /*
     * The snapshot type has no role, no account status, no owner flag, no
     * orders and no stores — so the only way to ask whether they could
     * manufacture a grant is to force them in past the type system, exactly as
     * a careless future adapter might. They change nothing, because there is no
     * code that reads them.
     */
    const ownerLike = {
      userId: ID.ownerLike,
      email: 'owner@example.invalid',
      membership: null,
      role: 'admin',
      status: 'active',
      isOwner: true,
      orders: 42,
      stores: ['flagship'],
    } as unknown as AccountSnapshot

    check(
      'an admin/owner-looking account with no membership row is an ordinary new grant',
      verdict(planOne({ userId: ID.ownerLike, scope: 'shopper' }, accountsOf(ownerLike))),
      'grant_new_active:would_grant',
    )

    const suspendedOwner = {
      ...ownerLike,
      membership: membership('vendor', 'suspended'),
    } as unknown as AccountSnapshot

    check(
      'and being an admin/owner does NOT lift a suspension',
      verdict(planOne({ userId: ID.ownerLike, scope: 'vendor' }, accountsOf(suspendedOwner))),
      'membership_suspended:blocked',
    )
    check(
      'nor does it conjure a membership for an account that has none on file',
      verdict(planOne({ userId: ID.ownerLike, scope: 'shopper' }, accountsOf())),
      'user_not_found:blocked',
    )
  }

  {
    const snapshotShape = stripComments(source(PLAN_LIB))
    assert(
      'AccountSnapshot carries exactly userId, email and membership',
      /export type AccountSnapshot = \{\s*userId: string\s*email: string \| null\s*membership: MembershipRow \| null\s*\}/.test(
        snapshotShape,
      ),
      'a fourth field is the change to argue about — that is how role leaks back in',
    )
  }

  console.log('\n-- vendor is entry, never selling ----------------------')

  {
    const plan = planOne(
      { userId: ID.noRowVendor, scope: 'vendor' },
      accountsOf(snapshot(ID.noRowVendor, null, null)),
    )
    const entry = plan.entries[0]

    check('the vendor plan is entry-scoped and nothing more', entry?.requestedScope, 'vendor')
    check(
      'and the planned entry carries no field beyond the reporting shape',
      Object.keys(entry ?? {}).sort(),
      [
        'detail',
        'disposition',
        'existingScope',
        'existingStatus',
        'index',
        'outcome',
        'requestedScope',
        'userId',
      ],
    )

    const sellingScan = [
      ['the planner', stripComments(source(PLAN_LIB))],
      ['the CLI', stripComments(source(PLAN_CLI))],
    ] as const

    for (const [label, text] of sellingScan) {
      assert(
        `${label} mentions no selling, listing, payout or inventory right`,
        !/\b(canSell|isSeller|sellerOf|payout|listingRight|inventoryRight)\b/i.test(text),
        'selling depends on vendors + vendor_memberships + compliance, none of which exist',
      )
    }

    /*
     * Read from `lib/marketplace/access.ts` rather than imported: that module's
     * VALUE importers are deliberately audited by
     * scripts/verify-marketplace-access.ts, and this file has no business
     * appearing on that list.
     */
    const accessCode = stripComments(source(join('lib', 'marketplace', 'access.ts')))
    assert(
      'and the resolver still declares selling as the literal false',
      /function authorizesSelling\([^)]*\): false\b/.test(accessCode),
      'the one inference most likely to be made by accident later',
    )
  }

  console.log('\n-- the whole plan: order and applicability --------------')

  {
    /*
     * A deliberately mixed manifest: two clean grants, a no-op, and three
     * different refusals, interleaved so that ordering cannot be an accident.
     */
    const manifest = parsedOk('mixed manifest', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.activeShopper, scope: 'vendor' },
        { userId: ID.noRowVendor, scope: 'vendor' },
        { userId: ID.suspendedShopper, scope: 'shopper' },
        { userId: ID.activeVendor, scope: 'vendor' },
        { userId: ID.unknownAccount, scope: 'shopper' },
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
        { userId: ID.revokedVendor, scope: 'vendor' },
      ],
    })

    const snapshots = [
      snapshot(ID.noRowShopper, null, null),
      snapshot(ID.activeShopper, null, membership('shopper', 'active')),
      snapshot(ID.noRowVendor, null, null),
      snapshot(ID.suspendedShopper, null, membership('shopper', 'suspended')),
      snapshot(ID.activeVendor, null, membership('vendor', 'active')),
      snapshot(ID.mismatched, 'someone.else@example.invalid', null),
      snapshot(ID.revokedVendor, null, membership('vendor', 'revoked')),
    ]

    const plan = planMembershipGrants(manifest, accountsOf(...snapshots))

    check(
      'each entry is classified, and in manifest order',
      plan.entries.map((entry) => `${entry.index}:${entry.outcome}`),
      [
        '0:grant_new_active',
        '1:scope_conflict',
        '2:grant_new_active',
        '3:membership_suspended',
        '4:already_active_same_scope',
        '5:user_not_found',
        '6:expected_email_mismatch',
        '7:membership_revoked',
      ],
    )
    check(
      'reporting does not stop at the first refusal',
      plan.entries.length,
      manifest.grants.length,
    )
    check(
      'the counters agree with the entries',
      [plan.wouldGrantCount, plan.noChangeCount, plan.blockedCount],
      [2, 1, 5],
    )
    check('and one refusal makes the WHOLE plan inapplicable', plan.applicable, false)

    /*
     * Output order follows the manifest and NOT the order the lookup happened
     * to return rows in. Feeding the same snapshots in reverse must produce a
     * byte-identical plan.
     */
    const reversed = planMembershipGrants(manifest, accountsOf(...[...snapshots].reverse()))
    check(
      'lookup order cannot reorder the report',
      JSON.stringify(reversed),
      JSON.stringify(plan),
    )
    check(
      'and the report text is byte-identical across runs',
      formatPlanReport(plan).join('\n'),
      formatPlanReport(planMembershipGrants(manifest, accountsOf(...snapshots))).join('\n'),
    )

    const report = formatPlanReport(plan).join('\n')
    assert(
      'the report says, in the first line, that it is a dry run',
      formatPlanReport(plan)[0].includes('DRY RUN'),
    )
    assert('and names the plan as not applicable', report.includes('NOT APPLICABLE'))
    assert(
      'it prints no email address, supplied or stored',
      !report.includes('@'),
      'a plan gets pasted into tickets; a mismatch is reportable without either address',
    )
    for (const grant of manifest.grants) {
      assert(`the report identifies the entry for ${grant.userId}`, report.includes(grant.userId))
    }
  }

  {
    const manifest = parsedOk('clean manifest', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.activeVendor, scope: 'vendor' },
      ],
    })
    const plan = planMembershipGrants(
      manifest,
      accountsOf(
        snapshot(ID.noRowShopper, null, null),
        snapshot(ID.activeVendor, null, membership('vendor', 'active')),
      ),
    )
    check('a manifest with no refusals IS applicable', plan.applicable, true)
    assert(
      'and even then the report insists nothing was written',
      formatPlanReport(plan).join('\n').includes('nothing was written'),
      'applicable means a later reviewed step could consider it, not that it happened',
    )
  }

  {
    /*
     * The ceiling is enforced in the planner too. A `GrantManifest` can be
     * hand-built as well as parsed, and a limit enforced in only one of the two
     * paths is a limit with a way around it.
     */
    const oversized = manifestOf(
      ...Array.from({ length: MAX_MANIFEST_GRANTS + 1 }, (_unused, index) => ({
        userId: fixtureId(300 + index),
        scope: 'shopper' as const,
      })),
    )
    let threw = false
    try {
      planMembershipGrants(oversized, accountsOf())
    } catch (error) {
      threw = error instanceof RangeError
    }
    assert(
      `planning ${MAX_MANIFEST_GRANTS + 1} hand-built grants throws`,
      threw,
      'the parser is not the only door into the planner',
    )
  }

  check(
    'every outcome in the vocabulary was exercised above',
    [...outcomesSeen].sort(),
    [...GRANT_PLAN_OUTCOMES].sort(),
  )

  console.log('\n-- a manifest lives outside the repository --------------')

  {
    /*
     * FIXTURE PATHS ONLY. Not one of these exists, nothing is created and
     * nothing is linked: `checkManifestLocation()` compares strings the CLI has
     * already resolved, so a symlink is modelled by handing it a declared path
     * and a DIFFERENT resolved path — which is precisely what `realpath` would
     * have returned. Both spellings of the repository root are exercised
     * because the boundary has to hold on the platforms this is run from.
     */
    const POSIX_ROOT = '/srv/cloudmarket'
    const WINDOWS_ROOT = 'C:\\src\\cloudmarket'

    const CASES: ReadonlyArray<{
      name: string
      root: string
      declared: string
      resolved?: string
      caseInsensitive?: boolean
      expect: ManifestLocationVerdict
      offending?: 'declared' | 'resolved' | 'repositoryRoot' | null
    }> = [
      {
        name: 'a manifest committed inside the tree',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket/ops/manifest.json',
        expect: 'inside_repository',
        offending: 'declared',
      },
      {
        name: 'one buried deep inside the tree',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket/lib/marketplace/manifest.json',
        expect: 'inside_repository',
        offending: 'declared',
      },
      {
        name: 'the repository root itself',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket',
        expect: 'is_repository_root',
        offending: 'declared',
      },
      {
        name: 'the repository root with a trailing separator',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket/',
        expect: 'is_repository_root',
        offending: 'declared',
      },
      {
        name: 'an outside path that is a link to a file inside',
        root: POSIX_ROOT,
        declared: '/home/operator/manifest.json',
        resolved: '/srv/cloudmarket/private/manifest.json',
        expect: 'inside_repository',
        offending: 'resolved',
      },
      {
        name: 'an outside path whose PARENT directory is a link inside',
        root: POSIX_ROOT,
        declared: '/home/operator/current/manifest.json',
        resolved: '/srv/cloudmarket/tmp/manifest.json',
        expect: 'inside_repository',
        offending: 'resolved',
      },
      {
        name: 'a manifest genuinely outside the tree',
        root: POSIX_ROOT,
        declared: '/home/operator/manifest.json',
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'a sibling directory whose name merely starts the same way',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket-notes/manifest.json',
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'and another one',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarketing/manifest.json',
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'a relative path, which cannot be compared at all',
        root: POSIX_ROOT,
        declared: 'manifest.json',
        expect: 'unusable_path',
        offending: 'declared',
      },
      {
        name: 'a path that still carries .. is refused, never folded',
        root: POSIX_ROOT,
        declared: '/srv/cloudmarket/../manifest.json',
        expect: 'unusable_path',
        offending: 'declared',
      },
      {
        name: 'a resolved path that is not absolute',
        root: POSIX_ROOT,
        declared: '/home/operator/manifest.json',
        resolved: 'manifest.json',
        expect: 'unusable_path',
        offending: 'resolved',
      },
      {
        name: 'a repository root that is not absolute',
        root: 'cloudmarket',
        declared: '/home/operator/manifest.json',
        expect: 'unusable_path',
        offending: 'repositoryRoot',
      },
      {
        name: 'windows: a manifest inside the tree',
        root: WINDOWS_ROOT,
        declared: 'C:\\src\\cloudmarket\\ops\\manifest.json',
        caseInsensitive: true,
        expect: 'inside_repository',
        offending: 'declared',
      },
      {
        name: 'windows: the same path in a different case',
        root: WINDOWS_ROOT,
        declared: 'C:\\SRC\\CloudMarket\\ops\\manifest.json',
        caseInsensitive: true,
        expect: 'inside_repository',
        offending: 'declared',
      },
      {
        name: 'windows: forward slashes are the same path',
        root: WINDOWS_ROOT,
        declared: 'C:/src/cloudmarket/ops/manifest.json',
        caseInsensitive: true,
        expect: 'inside_repository',
        offending: 'declared',
      },
      {
        name: 'windows: the repository root itself',
        root: WINDOWS_ROOT,
        declared: 'C:\\src\\cloudmarket',
        caseInsensitive: true,
        expect: 'is_repository_root',
        offending: 'declared',
      },
      {
        name: 'windows: a link from outside that lands inside',
        root: WINDOWS_ROOT,
        declared: 'D:\\ops\\manifest.json',
        resolved: 'C:\\src\\cloudmarket\\private\\manifest.json',
        caseInsensitive: true,
        expect: 'inside_repository',
        offending: 'resolved',
      },
      {
        name: 'windows: another drive is outside',
        root: WINDOWS_ROOT,
        declared: 'D:\\ops\\manifest.json',
        caseInsensitive: true,
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'windows: a sibling with a shared prefix is outside',
        root: WINDOWS_ROOT,
        declared: 'C:\\src\\cloudmarket-notes\\manifest.json',
        caseInsensitive: true,
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'windows: a UNC share is outside',
        root: WINDOWS_ROOT,
        declared: '\\\\fileserver\\ops\\manifest.json',
        caseInsensitive: true,
        expect: 'outside_repository',
        offending: null,
      },
      {
        name: 'a case-different path is OUTSIDE on a case-sensitive filesystem',
        root: WINDOWS_ROOT,
        declared: 'C:\\SRC\\CloudMarket\\ops\\manifest.json',
        caseInsensitive: false,
        expect: 'outside_repository',
        offending: null,
      },
    ]

    const verdictsSeen = new Set<ManifestLocationVerdict>()

    for (const entry of CASES) {
      const result = checkManifestLocation({
        repositoryRoot: entry.root,
        declaredPath: entry.declared,
        resolvedPath: entry.resolved ?? entry.declared,
        caseInsensitive: entry.caseInsensitive ?? false,
      })
      verdictsSeen.add(result.verdict)
      check(
        `${entry.name}: ${entry.expect}`,
        [result.verdict, result.offending],
        [entry.expect, entry.offending ?? null],
      )
    }

    check(
      'every location verdict in the vocabulary was exercised',
      [...verdictsSeen].sort(),
      [...MANIFEST_LOCATION_VERDICTS].sort(),
    )

    /* Containment is by segment. A shared prefix is not a shared directory. */
    assert(
      'containment is decided segment by segment, not by string prefix',
      isPathAtOrBeneath(POSIX_ROOT, '/srv/cloudmarket/x', false) &&
        !isPathAtOrBeneath(POSIX_ROOT, '/srv/cloudmarket-notes/x', false) &&
        isPathAtOrBeneath(POSIX_ROOT, POSIX_ROOT, false) &&
        !isPathAtOrBeneath(POSIX_ROOT, '/srv', false),
      'the parent of the root is not inside the root either',
    )
  }

  console.log('\n-- identity is established before membership is read ----')

  {
    const manifest = parsedOk('two-stage manifest', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.unknownAccount, scope: 'shopper' },
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
        {
          userId: ID.verified,
          scope: 'vendor',
          expectedEmail: 'fixture.eight@example.invalid',
        },
      ],
    })

    const trace = fakeLookup(
      manifest,
      [
        { userId: ID.noRowShopper, email: null },
        { userId: ID.mismatched, email: 'someone.else@example.invalid' },
        { userId: ID.verified, email: '  Fixture.Eight@Example.Invalid ' },
      ],
      [
        { userId: ID.verified, scope: 'vendor', status: 'active' },
        /* A row for an id that must never be asked about. */
        { userId: ID.mismatched, scope: 'vendor', status: 'active' },
      ],
    )

    check(
      'stage 1a asks users about exactly the ids the manifest named, projecting the id alone',
      trace.userQueries[0],
      {
        columns: ['users.id'],
        ids: [ID.noRowShopper, ID.unknownAccount, ID.mismatched, ID.verified],
      },
    )
    check(
      'stage 1b asks for the address of ONLY the two ids whose own entry asked',
      trace.userQueries[1],
      { columns: ['users.id', 'users.email'], ids: [ID.mismatched, ID.verified] },
    )
    check('and there is no third users query', trace.userQueries.length, 2)
    check(
      'so the address of the id that asked no question was never read',
      trace.accounts.get(ID.noRowShopper)?.email ?? null,
      null,
    )
    check(
      'stage 2 asks marketplace_access about the verified ids and no others',
      trace.membershipQueries.map((query) => query.ids),
      [[ID.noRowShopper, ID.verified]],
    )
    check(
      'projecting the membership key, scope and status \u2014 and no column of users',
      trace.membershipQueries[0].columns,
      ['marketplaceAccess.scope', 'marketplaceAccess.status', 'marketplaceAccess.userId'],
    )
    assert(
      'an unknown id is never the subject of a membership question',
      !trace.membershipQueries[0].ids.includes(ID.unknownAccount),
      'a typo\u2019d uuid must not become a membership lookup',
    )
    assert(
      'nor is an id whose address disagrees with the manifest',
      !trace.membershipQueries[0].ids.includes(ID.mismatched),
      'verification that happens after the read is verification that happened too late',
    )
    check(
      'an id with no expectedEmail proceeds once it is known to be a live account',
      trace.membershipQueries[0].ids.includes(ID.noRowShopper),
      true,
    )

    const plan = planMembershipGrants(manifest, trace.accounts)
    check(
      'and the PLANNER still assigns every outcome, from narrower data',
      plan.entries.map((entry) => `${entry.index}:${entry.outcome}`),
      [
        '0:grant_new_active',
        '1:user_not_found',
        '2:expected_email_mismatch',
        '3:already_active_same_scope',
      ],
    )
    check(
      'the membership row that existed for the refused id never reached a snapshot',
      trace.accounts.get(ID.mismatched)?.membership ?? null,
      null,
    )
    check(
      'and narrowing the reads did not change the verdict',
      plan.blockedCount,
      2,
    )
    for (const account of trace.accounts.values()) {
      check(
        `the snapshot for ${account.userId} carries three fields and no fourth`,
        Object.keys(account).sort(),
        ['email', 'membership', 'userId'],
      )
    }
  }

  {
    /* Nothing eligible: the second query is not issued at all. */
    const manifest = parsedOk('nothing eligible', {
      version: 1,
      grants: [
        { userId: ID.unknownAccount, scope: 'shopper' },
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
      ],
    })
    const trace = fakeLookup(
      manifest,
      [{ userId: ID.mismatched, email: 'someone.else@example.invalid' }],
      [{ userId: ID.mismatched, scope: 'vendor', status: 'active' }],
    )

    check(
      'stage 1 still runs — existence for both ids, an address for the one that asked',
      trace.userQueries,
      [
        { columns: ['users.id'], ids: [ID.unknownAccount, ID.mismatched] },
        { columns: ['users.id', 'users.email'], ids: [ID.mismatched] },
      ],
    )
    check(
      'and with nothing eligible, NO membership query is issued at all',
      trace.membershipQueries,
      [],
    )
    check(
      'and the planner refuses both entries anyway',
      planMembershipGrants(manifest, trace.accounts).entries.map((entry) => entry.outcome),
      ['user_not_found', 'expected_email_mismatch'],
    )
  }

  {
    /* An empty manifest asks nothing of anybody. */
    const manifest = parsedOk('empty two-stage manifest', { version: 1, grants: [] })
    const request = planUserLookup(manifest)
    const trace = fakeLookup(manifest, [], [])

    check('an empty manifest names no id', [...request.userIds], [])
    check('and asks for no address', [...request.emailVerificationUserIds], [])
    check(
      'so no query of any kind is issued',
      [trace.userQueries.length, trace.membershipQueries.length],
      [0, 0],
    )
  }

  {
    /* No entry asked for verification, so no address query is issued at all. */
    const manifest = parsedOk('unverified manifest', {
      version: 1,
      grants: [{ userId: ID.activeShopper, scope: 'shopper' }],
    })
    const request = planUserLookup(manifest)
    check(
      'no expectedEmail anywhere means no id requires verification',
      [...request.emailVerificationUserIds],
      [],
    )

    {
      const trace = fakeLookup(
        manifest,
        [{ userId: ID.activeShopper, email: 'never.projected@example.invalid' }],
        [{ userId: ID.activeShopper, scope: 'shopper', status: 'active' }],
      )
      check(
        'exactly one users query is issued, and it projects the id alone',
        trace.userQueries,
        [{ columns: ['users.id'], ids: [ID.activeShopper] }],
      )
      check('and not one stored address was read', trace.emailsRead, [])
      check(
        'and an id with no expectedEmail still reaches stage 2 on existence alone',
        trace.membershipQueries.map((query) => query.ids),
        [[ID.activeShopper]],
      )
      check(
        'with no address in the snapshot, because none was fetched',
        trace.accounts.get(ID.activeShopper)?.email ?? null,
        null,
      )
    }

    /*
     * A row carrying a role, a status and an owner flag — forced past the type
     * system exactly as a careless future adapter might. None of it survives
     * into the snapshot, because the snapshot is built field by field.
     */
    const hostileRow = {
      userId: ID.activeShopper,
      email: 'someone@example.invalid',
      role: 'admin',
      status: 'active',
      isOwner: true,
    } as unknown as LiveUserRow

    const verified = verifyIdentities(manifest, [hostileRow])
    check('the id is eligible on existence alone', [...verified.eligibleUserIds], [
      ID.activeShopper,
    ])
    check(
      'and the snapshot carries three fields, whatever the row carried',
      Object.keys(verified.snapshots.get(ID.activeShopper) ?? {}).sort(),
      ['email', 'membership', 'userId'],
    )
    check(
      'including the address the existence row had no business carrying',
      verified.snapshots.get(ID.activeShopper)?.email ?? null,
      null,
    )
    check(
      'an admin-looking row still gets an ordinary outcome',
      verdict(
        planMembershipGrants(
          manifest,
          attachMemberships(verified, [
            { userId: ID.activeShopper, scope: 'shopper', status: 'active' },
          ]),
        ),
      ),
      'already_active_same_scope:no_change',
    )
  }

  {
    /*
     * DEFENCE IN DEPTH. Even if a future adapter fetched membership for an id
     * stage 1 refused, the row is dropped rather than attached.
     */
    const manifest = parsedOk('mismatch manifest', {
      version: 1,
      grants: [
        {
          userId: ID.mismatched,
          scope: 'shopper',
          expectedEmail: 'expected.nine@example.invalid',
        },
      ],
    })
    const verified = verifyIdentities(
      manifest,
      [{ userId: ID.mismatched }],
      [{ userId: ID.mismatched, email: 'someone.else@example.invalid' }],
    )
    const forced = attachMemberships(verified, [
      { userId: ID.mismatched, scope: 'vendor', status: 'active' },
    ])

    check(
      'a membership row for an unverified id is dropped, not attached',
      forced.get(ID.mismatched)?.membership ?? null,
      null,
    )
    check(
      'so the plan still refuses on the address',
      verdict(planMembershipGrants(manifest, forced)),
      'expected_email_mismatch:blocked',
    )
  }

  {
    /* A row nobody asked about cannot enter the plan through the back door. */
    const manifest = parsedOk('one-id manifest', {
      version: 1,
      grants: [{ userId: ID.noRowShopper, scope: 'shopper' }],
    })
    const verified = verifyIdentities(manifest, [
      { userId: ID.noRowShopper },
      { userId: ID.activeVendor },
    ])

    check('only manifest ids become snapshots', [...verified.snapshots.keys()], [
      ID.noRowShopper,
    ])
    check('and only manifest ids become eligible', [...verified.eligibleUserIds], [
      ID.noRowShopper,
    ])
  }

  {
    /* Row order cannot reach the second query or the report. */
    const manifest = parsedOk('ordering manifest', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.activeVendor, scope: 'vendor' },
        { userId: ID.noRowVendor, scope: 'vendor' },
      ],
    })
    const rows: readonly LiveUserRow[] = [
      { userId: ID.noRowShopper },
      { userId: ID.activeVendor },
      { userId: ID.noRowVendor },
    ]

    check(
      'eligible ids come back in manifest order, not row order',
      [...verifyIdentities(manifest, [...rows].reverse()).eligibleUserIds],
      [ID.noRowShopper, ID.activeVendor, ID.noRowVendor],
    )
    check(
      'and the snapshots are byte-identical whichever order the rows arrived in',
      JSON.stringify([...verifyIdentities(manifest, rows).snapshots]),
      JSON.stringify([...verifyIdentities(manifest, [...rows].reverse()).snapshots]),
    )
  }

  console.log('\n-- an address is read only for the entry that asked -----')

  {
    /*
     * NO ENTRY ASKED, SO NOTHING ASKS. The existence list is every id the
     * manifest named; the verification list is empty, and an empty verification
     * list is not a narrower address query but no address query at all.
     */
    const manifest = parsedOk('no-verification manifest', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.activeVendor, scope: 'vendor' },
        { userId: ID.noRowVendor, scope: 'vendor' },
      ],
    })
    const request = planUserLookup(manifest)

    check(
      'the existence list is every explicit manifest id, in manifest order',
      [...request.userIds],
      [ID.noRowShopper, ID.activeVendor, ID.noRowVendor],
    )
    check('and the verification list is empty', [...request.emailVerificationUserIds], [])

    const trace = fakeLookup(
      manifest,
      [
        { userId: ID.noRowShopper, email: fixtureEmail(1) },
        { userId: ID.activeVendor, email: fixtureEmail(4) },
        { userId: ID.noRowVendor, email: fixtureEmail(2) },
      ],
      [{ userId: ID.activeVendor, scope: 'vendor', status: 'active' }],
    )

    check('so exactly one users query is issued', trace.userQueries.length, 1)
    check(
      'and its projection is users.id, with no address in it',
      trace.userQueries[0].columns,
      ['users.id'],
    )
    check('not one stored address is read', trace.emailsRead, [])
    check(
      'and no snapshot carries one',
      [...trace.accounts.values()].map((account) => account.email),
      [null, null, null],
    )
    check(
      'while all three ids still reach the membership lookup on existence alone',
      trace.membershipQueries.map((query) => query.ids),
      [[ID.noRowShopper, ID.activeVendor, ID.noRowVendor]],
    )
  }

  {
    /*
     * THE CASE THIS SLICE EXISTS FOR. Twenty-five grants, exactly one of which
     * carries an `expectedEmail`. Verifying that one must not read the other
     * twenty-four stored addresses: they answer no question anybody asked, and
     * fetching them and discarding them is not the same as never fetching them.
     */
    const VERIFIED_AT = 17
    const bulkId = (index: number) => fixtureId(400 + index)
    const bulkEmail = (index: number) => fixtureEmail(400 + index)

    const manifest = parsedOk('twenty-four unverified, one verified', {
      version: 1,
      grants: Array.from({ length: MAX_MANIFEST_GRANTS }, (_unused, index) =>
        index === VERIFIED_AT
          ? { userId: bulkId(index), scope: 'shopper', expectedEmail: bulkEmail(index) }
          : { userId: bulkId(index), scope: 'shopper' },
      ),
    })

    /* Every one of the twenty-five accounts HAS a stored address on file. */
    const stored: readonly FixtureUserRow[] = Array.from(
      { length: MAX_MANIFEST_GRANTS },
      (_unused, index) => ({ userId: bulkId(index), email: bulkEmail(index) }),
    )
    const allIds = stored.map((row) => row.userId)

    check('the fixture manifest is the full ceiling', manifest.grants.length, MAX_MANIFEST_GRANTS)
    check(
      'and exactly one of its entries carries an expectedEmail',
      manifest.grants.filter((grant) => grant.expectedEmail !== null).map((grant) => grant.userId),
      [bulkId(VERIFIED_AT)],
    )

    const trace = fakeLookup(manifest, stored, [])

    check(
      'the existence lookup names every manifest id, projecting users.id alone',
      trace.userQueries[0],
      { columns: ['users.id'], ids: allIds },
    )
    check(
      'the address lookup names ONLY the id whose own grant asked',
      trace.userQueries[1],
      { columns: ['users.id', 'users.email'], ids: [bulkId(VERIFIED_AT)] },
    )
    check('and there is no third users query', trace.userQueries.length, 2)
    check(
      'so exactly one stored address is read, out of twenty-five',
      trace.emailsRead,
      [bulkEmail(VERIFIED_AT)],
    )
    assert(
      'and not one of the other twenty-four addresses is read',
      stored.every(
        (row, index) =>
          index === VERIFIED_AT || row.email === null || !trace.emailsRead.includes(row.email),
      ),
      'one entry asking for verification must not conscript the whole manifest',
    )
    check(
      'no unrelated snapshot carries an address either',
      [...trace.accounts.values()]
        .filter((account) => account.email !== null)
        .map((account) => account.userId),
      [bulkId(VERIFIED_AT)],
    )
    check(
      'every live id — verified or not — still reaches the membership lookup',
      trace.membershipQueries.map((query) => query.ids),
      [allIds],
    )

    const plan = planMembershipGrants(manifest, trace.accounts)
    check(
      'and the planner classifies all twenty-five from that narrower data',
      [plan.entries.length, plan.wouldGrantCount, plan.blockedCount],
      [MAX_MANIFEST_GRANTS, MAX_MANIFEST_GRANTS, 0],
    )
    check(
      'the verified entry among them',
      plan.entries[VERIFIED_AT].outcome,
      'grant_new_active',
    )
  }

  {
    /*
     * VERIFICATION ASKED FOR, NOTHING ON FILE TO VERIFY AGAINST. The address
     * query is issued — that id asked — and comes back empty. A missing stored
     * address is a mismatch, and a mismatch is never a membership question.
     */
    const manifest = parsedOk('no address on file', {
      version: 1,
      grants: [{ userId: ID.mismatched, scope: 'shopper', expectedEmail: fixtureEmail(9) }],
    })
    const trace = fakeLookup(
      manifest,
      [{ userId: ID.mismatched, email: null }],
      [{ userId: ID.mismatched, scope: 'vendor', status: 'active' }],
    )

    check(
      'the address query was issued for the id that asked, and only that id',
      trace.userQueries[1],
      { columns: ['users.id', 'users.email'], ids: [ID.mismatched] },
    )
    check('but there was nothing to read', trace.emailsRead, [])
    check('so NO membership query is issued', trace.membershipQueries, [])
    check(
      'and the planner still owns the outcome',
      verdict(planMembershipGrants(manifest, trace.accounts)),
      'expected_email_mismatch:blocked',
    )
  }

  {
    /*
     * DEFENCE IN DEPTH, the other half. The adapter is not supposed to fetch an
     * address for an entry that asked no question — and if a future one did, the
     * pure module drops it rather than storing it on the snapshot.
     */
    const manifest = parsedOk('one asks, one does not', {
      version: 1,
      grants: [
        { userId: ID.noRowShopper, scope: 'shopper' },
        { userId: ID.verified, scope: 'vendor', expectedEmail: 'fixture.eight@example.invalid' },
      ],
    })
    const verified = verifyIdentities(
      manifest,
      [{ userId: ID.noRowShopper }, { userId: ID.verified }],
      [
        { userId: ID.noRowShopper, email: 'unasked.for@example.invalid' },
        { userId: ID.verified, email: '  Fixture.Eight@Example.Invalid ' },
      ],
    )

    check(
      'an address nobody asked for never reaches the snapshot',
      verified.snapshots.get(ID.noRowShopper)?.email ?? null,
      null,
    )
    check(
      'while the one that was asked for does, and verifies',
      verified.snapshots.get(ID.verified)?.email ?? null,
      '  Fixture.Eight@Example.Invalid ',
    )
    check(
      'so both ids are membership-eligible: one on existence, one on a match',
      [...verified.eligibleUserIds],
      [ID.noRowShopper, ID.verified],
    )
    check(
      'and the id that asked no question is still an ordinary new grant',
      planMembershipGrants(manifest, attachMemberships(verified, [])).entries.map(
        (entry) => entry.outcome,
      ),
      ['grant_new_active', 'grant_new_active'],
    )
  }

  console.log('\n-- the tooling cannot write ----------------------------')

  const libRaw = source(PLAN_LIB)
  const cliRaw = source(PLAN_CLI)
  const lib = analyze('the planner', PLAN_LIB, libRaw)
  const cli = analyze('the CLI', PLAN_CLI, cliRaw)
  const scanned = [lib, cli] as const

  /* Kept for the structural pins further down; capability is judged on the AST. */
  const libCode = lib.code
  const cliCode = cli.code

  assert(
    'both files were read',
    libRaw.length > 1000 && cliRaw.length > 1000,
    'a scan over an empty string passes everything',
  )
  assert(
    'and both parsed into a tree with statements in it',
    lib.identifiers.length > 50 && cli.identifiers.length > 50,
    'an unparsed file yields no facts, and no facts is not the same as no capability',
  )

  /*
   * 1. DATABASE API CAPABILITY. `db` has to be reachable from the CLI — it is
   *    how a read happens — so the question is not whether it is imported but
   *    which of its members the file can reach. Answered from the tree: every
   *    `db.<name>`, plus whether anything reaches one by computed name, which
   *    is how `db['insert']` would try to walk past a check like this.
   */
  check(
    'the CLI touches exactly one member of db, and it is select',
    unique(cli.dbMembers),
    ['select'],
  )
  check('the planner touches no member of db at all', unique(lib.dbMembers), [])

  for (const facts of scanned) {
    assert(
      `${facts.label} never reaches a member of db by computed name`,
      !facts.dynamicDbAccess,
      'db[name] is db.insert with the name moved out of reach of a scan',
    )
  }

  /*
   * 2. EXECUTABLE MUTATION PRIMITIVES, 3. MUTATION SQL TEXT and 4. APPLY
   *    CAPABILITY, all from `findings()` so that the same rules can be shown to
   *    fire on the hostile fixtures at the end of this file.
   */
  const RULES: ReadonlyArray<readonly [string, string]> = [
    ['db-api', 'member of db other than select'],
    ['mutation-primitive', 'mutation primitive'],
    ['mutation-sql', 'mutation SQL in any string or template'],
    ['apply-capability', 'apply, execute or force capability'],
  ]

  for (const facts of scanned) {
    const found = findings(facts)

    for (const [rule, description] of RULES) {
      const evidence = evidenceFor(found, rule)
      assert(`${facts.label} has no ${description}`, evidence.length === 0, evidence)
    }
  }

  /*
   * The import list is pinned outright rather than merely searched for bad
   * entries. A file that can only import these six things cannot import a
   * migrator, a driver, a child process or a prompt, and a future edit that
   * needs a seventh is an edit that gets read.
   */
  check('the planner imports nothing whatsoever', unique(lib.imports), [])
  check(
    'and the CLI imports exactly the six modules a read-only planner needs',
    unique(cli.imports),
    [
      '../lib/db',
      '../lib/db/schema',
      '../lib/marketplace/membership-grant-plan',
      'drizzle-orm',
      'node:fs',
      'node:path',
    ],
  )
  check(
    'taking only three predicates from drizzle — no sql, no mutation builder',
    unique(cli.importedNames.filter((entry) => entry.startsWith('drizzle-orm:'))),
    ['drizzle-orm:and', 'drizzle-orm:inArray', 'drizzle-orm:isNull'],
  )

  /* ACCOUNT CREATION. */
  const ACCOUNT_CREATION: ReadonlyArray<readonly [string, RegExp]> = [
    ['a NewUser insert type', /\bNewUser\b/],
    ['a user factory', /\b(?:createUser|insertUser|registerUser|signUp)\b/i],
    ['password handling', /\b(?:passwordHash|hashPassword|scrypt)\b/i],
    ['session or token minting', /\b(?:createSession|issueToken|verificationTokens)\b/],
  ]

  for (const [label, pattern] of ACCOUNT_CREATION) {
    assert(`the planner has no ${label}`, !pattern.test(libCode))
    assert(`the CLI has no ${label}`, !pattern.test(cliCode))
  }

  /* INFERENCE SOURCES — the columns and tables membership must never come from. */
  const INFERENCE: ReadonlyArray<readonly [string, RegExp]> = [
    ['users.role', /\busers\.role\b|\buserRole\b|\buser\.role\b/],
    ['users.status', /\busers\.status\b|\buserStatus\b|\buser\.status\b/],
    ['the session user', /\bSessionUser\b|\bgetCurrentUser\b/],
    ['owner identity', /CLOUDMARKET_OWNER|\badminBackup\b|\bresolveAdminIdentity\b/],
    ['permissions', /\buserPermissions\b/],
    ['orders', /\borders\b(?!\s*:)/],
    ['stores or vendors', /\bstores\b|\bvendors\b|\bvendorMemberships\b/],
    ['invites', /\binviteCodes\b|\binviteCodeRedemptions\b/],
  ]

  for (const [label, pattern] of INFERENCE) {
    assert(`the planner never reaches for ${label}`, !pattern.test(libCode))
    assert(`the CLI never reaches for ${label}`, !pattern.test(cliCode))
  }

  console.log('\n-- the planner is pure; the CLI reads narrowly ----------')

  /*
   * 5. PLANNER PURITY, from the tree rather than from the text. No import of
   *    any kind — static, dynamic, `require` or `import =` — and no syntax that
   *    could suspend on I/O. A module with nothing to reach a socket with is a
   *    module that cannot reach a write.
   */
  assert(
    'the planner has NO imports at all',
    lib.imports.length === 0,
    `found: ${unique(lib.imports).join(', ')}`,
  )
  assert(
    'and no async function, and nothing awaited',
    !lib.hasAsync && !lib.hasAwait,
    'dependency-free is what lets it be tested exactly as it runs',
  )
  {
    const AMBIENT_IO = [
      'process',
      'fetch',
      'require',
      'globalThis',
      'Buffer',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'queueMicrotask',
    ]
    const reached = AMBIENT_IO.filter((name) => lib.identifiers.includes(name))
    check('and names no ambient way out of the process', reached, [])
  }

  {
    const columns = cli.pairs.filter(
      (pair) => pair.startsWith('users.') || pair.startsWith('marketplaceAccess.'),
    )
    check(
      'the CLI projects only identity, verification address and membership scope/status',
      unique(columns),
      [
        'marketplaceAccess.scope',
        'marketplaceAccess.status',
        'marketplaceAccess.userId',
        'users.deletedAt',
        'users.email',
        'users.id',
      ],
    )
  }

  {
    /*
     * 10. THE PROJECTIONS, READ OFF THE PARSE TREE. Three selects, each one a
     * different question with a different answer:
     *
     *   · EXISTENCE projects `users.id` alone — an address is not needed to
     *     answer "does this account exist", so it is not fetched to answer it.
     *   · VERIFICATION projects `users.id` and `users.email`, and runs over a
     *     strictly smaller id list.
     *   · MEMBERSHIP projects the key, the scope and the status.
     *
     * `users.role` and `users.status` appear in none of them — not unread, but
     * never fetched, which is a different and much stronger claim.
     */
    const projections = selectProjections(PLAN_CLI, cli.withoutComments)

    check(
      'the CLI issues exactly three selects: existence, verification, membership',
      projections,
      [
        ['users.id'],
        ['users.email', 'users.id'],
        ['marketplaceAccess.scope', 'marketplaceAccess.status', 'marketplaceAccess.userId'],
      ],
    )
    assert(
      'and no projection anywhere names users.role or users.status',
      !projections.some(
        (columns) => columns.includes('users.role') || columns.includes('users.status'),
      ),
      'a column that is never fetched cannot be reasoned from by accident',
    )
    check(
      'the planner selects nothing at all, having no db to select from',
      selectProjections(PLAN_LIB, lib.withoutComments),
      [],
    )
  }

  assert(
    'the lookup is bounded by ids handed to it — no wildcard scan, no backfill',
    (cliCode.match(/inArray\(users\.id, \[\.\.\.ids\]\)/g) ?? []).length === 2 &&
      /inArray\(marketplaceAccess\.userId, \[\.\.\.verifiedIds\]\)/.test(cliCode),
    'a select with no id predicate is a backfill waiting for a where clause',
  )
  assert(
    'and the address query is bounded to the verification subset, not to the manifest',
    /readVerificationEmails\(request\.emailVerificationUserIds\)/.test(cli.withoutComments) &&
      /readLiveUserIds\(request\.userIds\)/.test(cli.withoutComments),
    'one entry asking for verification must not widen the read to every other entry',
  )
  assert(
    'and it is skipped entirely when no entry asked',
    /request\.emailVerificationUserIds\.length === 0/.test(cliCode),
    'an empty subset means no query, not a query with an empty IN list',
  )
  assert(
    'soft-deleted accounts are not found — by EITHER users query',
    (cliCode.match(/isNull\(users\.deletedAt\)/g) ?? []).length === 2,
    'a deleted account reappearing as a member would be a surprising undelete, and its stored address is not read either',
  )
  assert(
    'an empty manifest opens no connection at all',
    /request\.userIds\.length === 0/.test(cliCode),
  )
  assert(
    'the CLI never reads the environment itself, so it cannot print it',
    !/process\.env/.test(cliCode),
    'DATABASE_URL is the driver’s business, not this tool’s',
  )
  assert(
    'and anything shaped like a connection string is redacted before printing',
    /redact\(/.test(cliCode) && /postgres/.test(cliCode),
  )

  console.log('\n-- the CLI is unmistakably dry-run ----------------------')

  assert(
    'it demands exactly one argument',
    /args\.length !== 1/.test(cliCode),
    'an optional manifest path is how a tool grows a default target',
  )
  assert(
    'and refuses anything that looks like an option',
    /argument\.startsWith\('-'\)/.test(cli.withoutComments),
    'no flag exists, so any flag is a mistake worth stopping for',
  )
  assert(
    'the exit code is the plan verdict',
    /process\.exit\(plan\.applicable \? 0 : 1\)/.test(cliCode),
    'a non-applicable plan must not look like success to a script',
  )
  assert(
    'a refused manifest exits non-zero before any lookup',
    /if \(!parsed\.ok\)/.test(cliCode) &&
      cliCode.indexOf('parsed.ok') < cliCode.indexOf('lookupAccounts(parsed.manifest)'),
    'validating after reading the database is validating too late',
  )

  console.log('\n-- the CLI asks the pure module before it reads ---------')

  /*
   * The path check and the two-stage lookup are DECISIONS, and the decisions
   * live in the pure module where the fixtures below can exercise the real
   * thing. What is left in the CLI is the order the decisions are asked in —
   * which is exactly what a source pin is good for. If this glue is rewritten,
   * these break, and the fixtures alone would no longer prove anything about
   * what the CLI does.
   */
  for (const fragment of [
    'const { declaredPath, resolvedPath } = locateManifest(argument)',
    'const location = checkManifestLocation({',
    "if (location.verdict === 'outside_repository') return { declaredPath, resolvedPath }",
    'const request = planUserLookup(manifest)',
    'if (request.userIds.length === 0) return new Map()',
    'const liveUsers = await readLiveUserIds(request.userIds)',
    'request.emailVerificationUserIds.length === 0',
    ': await readVerificationEmails(request.emailVerificationUserIds)',
    'const verified = verifyIdentities(manifest, liveUsers, storedEmails)',
    'if (verified.eligibleUserIds.length === 0) return verified.snapshots',
    'const membershipRows = await readMemberships(verified.eligibleUserIds)',
    'return attachMemberships(verified, membershipRows)',
  ]) {
    assert(`the CLI still reads: ${fragment}`, cli.withoutComments.includes(fragment))
  }

  {
    /*
     * ORDER, stated as offsets in the file: the boundary check precedes the
     * open, the open precedes the parse, and every one of them precedes the
     * first row. A manifest in the wrong place is refused on the strength of
     * its path alone.
     */
    const at = (needle: string) => cli.withoutComments.indexOf(needle)
    const steps: ReadonlyArray<readonly [string, number]> = [
      ['the boundary check', at('locateManifest(argument)')],
      ['reading the file', at('readFileSync(manifestPath')],
      ['parsing the JSON', at('JSON.parse(text)')],
      ['validating the manifest', at('parseGrantManifest(document)')],
      ['looking anything up', at('lookupAccounts(parsed.manifest)')],
    ]

    for (const [label, offset] of steps) assert(`main() performs ${label}`, offset > 0)
    for (let index = 1; index < steps.length; index += 1) {
      assert(
        `${steps[index - 1][0]} happens before ${steps[index][0]}`,
        steps[index - 1][1] < steps[index][1],
      )
    }
  }

  assert(
    'the repository root comes from the script location, never from the shell',
    /const REPOSITORY_ROOT = canonicalize\(resolve\(__dirname, '\.\.'\)\)/.test(
      cli.withoutComments,
    ) && !/process\.cwd/.test(cli.withoutComments),
    'cwd is chosen by whoever is running the command, which is the wrong half of a boundary check',
  )
  assert(
    'both the declared path and the link-resolved path are handed to the check',
    /declaredPath,\s*\n?\s*resolvedPath,/.test(cli.withoutComments) &&
      /const resolvedPath = canonicalizeDeepest\(declaredPath\)/.test(cli.withoutComments),
    'one of the two is the ordinary mistake and the other is the interesting one',
  )
  assert(
    'and the manifest is only ever read, never written, moved or copied',
    unique(cli.calledFunctions).filter((name) => /^(?:write|copy|rename|unlink|mkdir|rm)/i.test(name))
      .length === 0 &&
      unique(cli.importedNames.filter((entry) => entry.startsWith('node:fs:'))).join(',') ===
        'node:fs:readFileSync,node:fs:realpathSync',
    'the manifest is an input; an input in the wrong place is a refusal, not a relocation',
  )

  console.log('\n-- the scanner itself is worth believing ---------------')

  {
    /*
     * A GUARD NOBODY HAS SEEN FIRE IS A GUARD NOBODY HAS TESTED.
     *
     * These fixtures are text, parsed and thrown away. Nothing here is written
     * to disk, imported or executed — `createSourceFile` reads a string. The
     * first must report every rule; the second must report none, because
     * everything prohibited in it is in a comment; the third is the exact shape
     * that defeated the previous version of this scan.
     */
    const HOSTILE = [
      "import { db } from '../lib/db'",
      "const statement = 'INSERT INTO marketplace_access (user_id, scope) VALUES ($1, $2)'",
      'const generated = `UPDATE ${table} SET status = 1`',
      "const wanted = process.argv.includes('--apply')",
      'async function applyGrants() {',
      '  await db.insert(marketplaceAccess).values(rows).onConflictDoNothing().returning()',
      '}',
    ].join('\n')

    const hostile = findings(analyze('a hostile fixture', 'hostile.ts', HOSTILE))

    for (const [rule] of RULES) {
      const evidence = evidenceFor(hostile, rule)
      assert(
        `a hostile fixture is reported for ${rule}`,
        evidence.length > 0,
        `nothing was reported for ${rule}, so that guard proves nothing`,
      )
    }
    assert(
      'including mutation SQL that only ever appears inside a quoted string',
      evidenceFor(hostile, 'mutation-sql').includes('INSERT statement'),
      'the previous scan blanked strings before looking, which hid the only place SQL is written',
    )
    assert(
      'and mutation SQL assembled across a template hole',
      evidenceFor(hostile, 'mutation-sql').includes('UPDATE statement'),
      'UPDATE ${table} SET is an UPDATE ... SET to Postgres, so it must be one to the scanner',
    )

    const HARMLESS = [
      '// INSERT INTO marketplace_access — described here, never done',
      '/* UPDATE marketplace_access SET status = 1, and DELETE FROM it, both refused */',
      '// there is no --apply flag and db.insert() is never called',
      "const plan = { outcome: 'grant_new_active' }",
      'const chosen = list.filter((row) => row.userId === plan.outcome)',
    ].join('\n')

    const harmless = findings(analyze('a harmless fixture', 'harmless.ts', HARMLESS))
    check(
      'prose about mutation in a comment is reported as nothing at all',
      harmless.map((entry) => `${entry.rule}:${entry.evidence}`),
      [],
    )

    /*
     * The regex in `redact()` contains a quote inside a character class. A
     * scanner that blanks strings with a regular expression treats it as the
     * start of a literal and swallows the code that follows — which is how a
     * mutation call three lines later becomes invisible. The parser does not
     * have that problem, so all three rules must still fire here.
     */
    const CONFUSING = [
      String.raw`const redactor = /postgres(?:ql)?:[/][/][^\s'"]+/gi`,
      String.raw`const statement = 'DELETE FROM marketplace_access'`,
      'await db.delete(marketplaceAccess)',
    ].join('\n')

    const confusing = findings(analyze('a confusing fixture', 'confusing.ts', CONFUSING))

    for (const rule of ['db-api', 'mutation-primitive', 'mutation-sql']) {
      assert(
        `a quote inside a regex literal does not hide ${rule}`,
        evidenceFor(confusing, rule).length > 0,
        'this is the lexical confusion the parse tree exists to remove',
      )
    }

    /*
     * AND THE VOCABULARY IN THIS FILE IS NOT THE VOCABULARY IN THOSE. This file
     * has to spell out what it forbids; pointing the scanner at it would report
     * findings, which is exactly why the scan names two files and this is not
     * one of them.
     */
    const self = analyze('this verifier', THIS_FILE, source(THIS_FILE))
    assert(
      'this file would report findings if it were scanned — so it never is',
      findings(self).length > 0,
      'fixture vocabulary and capability are different things, and only one is scanned',
    )
    check(
      'the capability scan is pointed at exactly two files',
      scanned.map((facts) => facts.file).sort(),
      [PLAN_LIB, PLAN_CLI].sort(),
    )
  }

  console.log('\n-- no manifest, and no real identity, is committed ------')

  {
    /*
     * A manifest names real accounts and real addresses, which is exactly why
     * it is an input from outside the repository and never a file inside it.
     * The tree is walked for any JSON document shaped like one.
     */
    const skipDirectories = new Set(['node_modules'])
    const found: string[] = []

    function walk(directory: string) {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry)
        if (statSync(full).isDirectory()) {
          if (!skipDirectories.has(entry) && !entry.startsWith('.')) walk(full)
          continue
        }
        if (!entry.endsWith('.json')) continue
        if (entry === 'package-lock.json') continue
        if (statSync(full).size > 1_000_000) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(readFileSync(full, 'utf8'))
        } catch {
          continue
        }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          'grants' in parsed
        ) {
          found.push(relative(ROOT, full))
        }
      }
    }

    walk(ROOT)
    check('no grant manifest exists in the repository', found, [])
  }

  assert(
    'no fixture in this file uses a deliverable email domain',
    ![...source(join('scripts', 'verify-marketplace-membership-plan.ts')).matchAll(
      /[\w.+-]+@([\w.-]+)/g,
    )].some((match) => !match[1].toLowerCase().endsWith('.invalid')),
    'fixture identities are invented; .invalid is reserved so they cannot belong to anyone',
  )
  assert(
    'and the shipped tooling contains no email address at all',
    !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(libRaw) && !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(cliRaw),
    'no customer address, invented or otherwise, belongs in the planner or the CLI',
  )

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
