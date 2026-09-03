/**
 * Notification reads and mutations — behaviour checks and safety guards.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-notifications.ts
 *
 * `--conditions=react-server` resolves the `server-only` import to the empty
 * module, exactly as the Next build does. Without it the import throws, which is
 * the point of `server-only` and not a fault here.
 *
 * HERMETIC BY CONSTRUCTION. No database, no network, no `.env.local`, no request
 * scope, no child process. The environment values assigned below are throwaway
 * fixtures needed only because `lib/env.ts` validates at import time, and the
 * connection string never opens a connection: `lib/db`'s pool is built on first
 * use, and this file installs a recording stand-in on the same global slot the
 * driver caches into, so the real pool is never constructed at all. Every id is
 * an invented UUID.
 *
 * TWO KINDS OF EVIDENCE, DELIBERATELY.
 *
 *   · EXECUTION, for everything that touches a row. The owner-scoped functions
 *     in `lib/notifications/queries.ts` are called for real, and the drizzle
 *     expressions they hand the driver are rendered to SQL by the repository's
 *     own `PgDialect`. So "scoped to the owner", "newest first", "unread only"
 *     and "idempotent `coalesce`" are read off the statement that would have
 *     been sent to Postgres, not off a comment claiming it would be.
 *   · THE PARSE TREE, for the two boundaries that cannot be executed outside a
 *     request. `getCurrentUser()` reads a cookie and `revalidatePath()` needs a
 *     work store, so the anonymous branches and the action shells are asserted
 *     against the compiler's view of the real source — declared parameters, the
 *     exact statement order of the fail-closed guards, and the complete export
 *     list of the `'use server'` module. Comments are stripped first, so these
 *     read code and not prose about code.
 *
 * WHAT THIS IS PROVING. Not that the code runs, but six claims:
 *
 *   1. UI-FACING IDENTITY IS SERVER-DERIVED ONLY. `getMyNotifications()` and
 *      `getUnreadNotificationCount()` declare no parameters; the two actions
 *      declare `(previousState, formData)` and their only domain input is a
 *      `notificationId`. There is no argument, form field or schema key through
 *      which a caller can name an account.
 *   2. THE `'use server'` MODULE PUBLISHES EXACTLY TWO ENDPOINTS. Every export of
 *      such a module is callable from the internet with arguments of the
 *      caller's choosing, so the export list is checked as a whole — including
 *      re-exports, which is how an owner-id-taking helper would most plausibly
 *      escape into being one.
 *   3. ANONYMOUS CALLERS GET `[]` AND `0`, from a guard that runs before any
 *      database work, so a signed-out visitor issues no query.
 *   4. OWNERSHIP IS IN THE STATEMENT. Every read and both writes bind
 *      `user_id`, and the individual mark binds `id AND user_id` — so a foreign
 *      id and a nonexistent id are one outcome rather than two.
 *   5. THE SINGLE MARK IS IDEMPOTENT AND `updated_at` STILL MOVES.
 *   6. MARK-ALL TOUCHES THE OWNER'S UNREAD ROWS AND NOTHING ELSE.
 *
 * REQUIRES THE DATABASE LANE. `lib/db/schema/notifications.ts` must exist and be
 * exported from the schema barrel; until it lands, the dynamic imports below
 * fail and say so.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

/** Type-only, and therefore erased — this pulls in nothing at runtime. */
import type { SQL } from 'drizzle-orm'

const ROOT = join(__dirname, '..')

const QUERIES = join('lib', 'notifications', 'queries.ts')
const ACTIONS = join('lib', 'notifications', 'actions.ts')
const THIS_FILE = join('scripts', 'verify-notifications.ts')

/** Where a call site could plausibly live. `node_modules` and build output are not it. */
const SCANNED_DIRECTORIES = ['app', 'components', 'lib', 'scripts'] as const
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js'] as const

/* Invented ids. Two owners, so "scoped to one" is a claim with a counterexample. */
const OWNER_A = 'a0000000-0000-4000-8000-000000000001'
const OWNER_B = 'b0000000-0000-4000-8000-000000000002'
const NOTIFICATION = 'c0000000-0000-4000-8000-000000000003'
const FOREIGN_NOTIFICATION = 'c0000000-0000-4000-8000-000000000004'
const UNKNOWN_NOTIFICATION = 'c0000000-0000-4000-8000-000000000005'

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

/* -------------------------------------------------------------------------- */
/* Reading the modules the way the compiler reads them                         */
/* -------------------------------------------------------------------------- */

type ExportedFunction = {
  name: string
  /** Declared parameter names, in order, as written. */
  parameters: readonly string[]
  /** Declared parameter types, in order. Empty string when untyped. */
  parameterTypes: readonly string[]
  returnType: string
  /** Body with comments removed and whitespace collapsed. */
  body: string
}

type Module = {
  file: string
  source: ts.SourceFile
  /** The leading string-literal directive, e.g. `use server`, or null. */
  directive: string | null
  /** Module specifiers of every bare `import '...'` side-effect import. */
  sideEffectImports: readonly string[]
  /** Every module specifier imported, side-effect or not. */
  imports: readonly string[]
  functions: readonly ExportedFunction[]
  /** Names of every exported VALUE declaration, functions included. */
  exportedValues: readonly string[]
  /** True when the file contains `export { … }` or `export * from …`. */
  hasReExport: boolean
  /** The whole file, comments removed and whitespace collapsed. */
  code: string
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function condense(text: string): string {
  return stripComments(text).replace(/\s+/g, ' ').trim()
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  )
}

function readModule(relativePath: string): Module {
  const raw = readFileSync(join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
  const source = ts.createSourceFile(
    relativePath,
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const first = source.statements[0]
  const directive =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression)
      ? first.expression.text
      : null

  const sideEffectImports: string[] = []
  const imports: string[] = []
  const functions: ExportedFunction[] = []
  const exportedValues: string[] = []
  let hasReExport = false

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : '(computed)'
      imports.push(specifier)
      if (statement.importClause === undefined) sideEffectImports.push(specifier)
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      /* `export * from …` and `export { … }` alike. Type-only ones are erased. */
      if (statement.isTypeOnly !== true) hasReExport = true
      continue
    }

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (!isExported(statement)) continue
      exportedValues.push(statement.name.text)
      functions.push({
        name: statement.name.text,
        parameters: statement.parameters.map((parameter) => parameter.name.getText(source)),
        parameterTypes: statement.parameters.map(
          (parameter) => parameter.type?.getText(source) ?? '',
        ),
        returnType: statement.type?.getText(source) ?? '',
        body: statement.body === undefined ? '' : condense(statement.body.getText(source)),
      })
      continue
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        exportedValues.push(declaration.name.getText(source))
      }
      continue
    }

    if (ts.isClassDeclaration(statement) && isExported(statement) && statement.name) {
      exportedValues.push(statement.name.text)
    }
  }

  return {
    file: relativePath,
    source,
    directive,
    sideEffectImports,
    imports,
    functions,
    exportedValues,
    hasReExport,
    code: condense(raw),
  }
}

function functionOf(module: Module, name: string): ExportedFunction {
  const found = module.functions.find((entry) => entry.name === name)
  if (found === undefined) {
    failures += 1
    console.log(`FAIL  ${module.file} exports ${name}`)
  }
  return found ?? { name, parameters: [], parameterTypes: [], returnType: '', body: '' }
}

/** The property names of the object literal passed to `z.object({ … })`. */
function zodObjectKeys(module: Module, schemaName: string): readonly string[] {
  const keys: string[] = []

  function walk(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === schemaName &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length > 0
    ) {
      const shape = node.initializer.arguments[0]
      if (ts.isObjectLiteralExpression(shape)) {
        for (const property of shape.properties) {
          if (property.name !== undefined) keys.push(property.name.getText(module.source))
        }
      }
    }
    node.forEachChild(walk)
  }

  walk(module.source)
  return keys.sort()
}

/** Every source file under the scanned directories, as repository-relative paths. */
function sourceFiles(): readonly string[] {
  const found: string[] = []

  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue

      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        found.push(relative(ROOT, path))
      }
    }
  }

  for (const directory of SCANNED_DIRECTORIES) walk(join(ROOT, directory))
  return found
}

/* -------------------------------------------------------------------------- */
/* A database that records instead of connecting                               */
/* -------------------------------------------------------------------------- */

type Recorded = { method: string; args: readonly unknown[] }

/**
 * A stand-in for the drizzle instance, installed on `globalThis.cloudMarketDb`.
 *
 * That slot is the one `lib/db`'s lazy `getDb()` checks FIRST, before it reads
 * the environment or constructs a pool — so filling it in is what makes this
 * file hermetic. The recorder implements only the builder methods the module
 * under test actually uses; anything else is a `TypeError`, which is the loud
 * failure a silent stub would hide.
 *
 * The chain is thenable, exactly as drizzle's own builders are, so `await`
 * resolves it to whichever rows the current scenario supplies.
 */
function createRecordingDb() {
  const statements: Recorded[][] = []
  let rows: readonly unknown[] = []

  const CHAIN_METHODS = ['from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning']

  function begin(method: string, args: readonly unknown[]) {
    const recorded: Recorded[] = [{ method, args }]
    statements.push(recorded)

    const chain: Record<string, unknown> = {
      then(resolve: (value: unknown) => void) {
        resolve(rows)
      },
    }

    for (const name of CHAIN_METHODS) {
      chain[name] = (...called: unknown[]) => {
        recorded.push({ method: name, args: called })
        return chain
      }
    }

    return chain
  }

  return {
    instance: {
      select: (...args: unknown[]) => begin('select', args),
      update: (...args: unknown[]) => begin('update', args),
      insert: (...args: unknown[]) => begin('insert', args),
      delete: (...args: unknown[]) => begin('delete', args),
    },
    statements,
    setRows(next: readonly unknown[]) {
      rows = next
    },
    reset() {
      statements.length = 0
      rows = []
    },
  }
}

/** The single statement the call under test issued. Fails loudly if not one. */
function onlyStatement(statements: readonly Recorded[][], label: string): readonly Recorded[] {
  if (statements.length !== 1) {
    failures += 1
    console.log(`FAIL  ${label} issues exactly one statement\n        issued ${statements.length}`)
  }
  return statements[0] ?? []
}

function argumentOf(statement: readonly Recorded[], method: string): unknown {
  return statement.find((entry) => entry.method === method)?.args[0]
}

function methodsOf(statement: readonly Recorded[]): readonly string[] {
  return statement.map((entry) => entry.method)
}

async function main() {
  /*
   * Fixtures. `lib/env.ts` parses the public schema at import time, so these
   * must be in place before the dynamic imports below — which is exactly why
   * those imports are dynamic. Assigned with `=` rather than `??=`, so a value
   * in a developer's shell cannot become the thing under test.
   */
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  process.env.AUTH_SECRET = 'verify-notifications-fixture-auth-secret-000000'
  process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture'

  /*
   * The seam. `lib/db` caches its drizzle instance on this global slot and
   * returns it before it reads the environment or builds a pool, so filling it
   * in here means the module under test runs its real statements against a
   * recorder and no connection is ever attempted.
   */
  const recorder = createRecordingDb()
  ;(globalThis as unknown as { cloudMarketDb: unknown }).cloudMarketDb = recorder.instance

  let schema!: Record<string, unknown>
  let pgCore!: typeof import('drizzle-orm/pg-core')
  let queries!: typeof import('../lib/notifications/queries')

  try {
    schema = (await import('../lib/db/schema')) as unknown as Record<string, unknown>
    pgCore = await import('drizzle-orm/pg-core')
    queries = await import('../lib/notifications/queries')
  } catch (error) {
    console.log(
      'FAIL  the notification modules load\n' +
        `        ${error instanceof Error ? error.message : String(error)}\n` +
        '        lib/db/schema/notifications.ts comes from the database lane;\n' +
        '        run with: npx tsx --conditions=react-server scripts/verify-notifications.ts',
    )
    process.exitCode = 1
    return
  }

  const dialect = new pgCore.PgDialect()

  /** A drizzle expression as the SQL and parameters Postgres would receive. */
  function render(expression: unknown): { sql: string; params: readonly unknown[] } {
    const query = dialect.sqlToQuery(expression as SQL)
    return { sql: query.sql, params: query.params }
  }

  console.log('\n-- the column contract the read layer depends on --------')

  const notifications = schema.notifications
  assert(
    'lib/db/schema exports `notifications`',
    notifications !== undefined,
    'the database lane owns this table; nothing below can be checked without it',
  )
  if (notifications === undefined) {
    process.exitCode = 1
    return
  }

  {
    const table = pgCore.getTableConfig(
      schema.notifications as Parameters<typeof pgCore.getTableConfig>[0],
    )
    const columns = new Map(table.columns.map((column) => [column.name, column]))

    check('the table is `notifications`', table.name, 'notifications')

    /*
     * `body` NULLABLE is the reason `NotificationView.body` is `string | null`.
     * A view type promising `string` would either lie or force the read layer to
     * invent an empty string that no row contains.
     */
    check('body is nullable', columns.get('body')?.notNull, false)
    check('and is text', columns.get('body')?.getSQLType(), 'text')

    /*
     * UNREAD IS `read_at IS NULL` AND NOTHING ELSE. A default would mean every
     * inserted row arrives read; a stored boolean beside it would mean two
     * sources of truth, and the count and the list would eventually disagree.
     */
    check('read_at is nullable', columns.get('read_at')?.notNull, false)
    check('and has no default', columns.get('read_at')?.hasDefault, false)

    /* Ownership is a non-null uuid, so no row is unowned and none is shared. */
    check('user_id is not null', columns.get('user_id')?.notNull, true)
    check('and is a uuid', columns.get('user_id')?.getSQLType(), 'uuid')
    check(
      'user_id references users.id',
      table.foreignKeys
        .flatMap((key) => key.reference().foreignColumns.map((column) => column.name))
        .sort(),
      ['id'],
    )

    /*
     * NO SOFT DELETE, asserted rather than assumed. Every read in
     * `lib/notifications/queries.ts` omits a `deleted_at IS NULL` predicate. If
     * this table ever gains that column, those reads start returning retired
     * rows — so the assumption is pinned here instead of living in a comment.
     */
    assert(
      'there is no soft-delete column to have forgotten to filter on',
      !columns.has('deleted_at'),
      'the reads carry no deleted_at predicate; adding the column means adding one',
    )

    check('updated_at exists and is not null', columns.get('updated_at')?.notNull, true)
  }

  console.log('\n-- reads are scoped to one owner, newest first ----------')

  {
    recorder.reset()
    recorder.setRows([
      {
        id: NOTIFICATION,
        title: 'Order confirmed',
        body: null,
        readAt: null,
        createdAt: new Date('2026-03-02T10:00:00Z'),
      },
      {
        id: FOREIGN_NOTIFICATION,
        title: 'Back in stock',
        body: 'Your saved item returned.',
        readAt: new Date('2026-03-01T09:00:00Z'),
        createdAt: new Date('2026-03-01T08:00:00Z'),
      },
    ])

    const list = await queries.listNotificationsForOwner(OWNER_A)
    const statement = onlyStatement(recorder.statements, 'listNotificationsForOwner')

    check(
      'the list is one SELECT, filtered and ordered',
      methodsOf(statement),
      ['select', 'from', 'where', 'orderBy'],
    )

    const where = render(argumentOf(statement, 'where'))
    assert(
      'scoped by user_id',
      where.sql.includes('"notifications"."user_id" = $1'),
      where.sql,
    )
    check('bound to the owner asked for', where.params, [OWNER_A])
    assert(
      'and to no other account',
      !JSON.stringify(where.params).includes(OWNER_B),
      where.sql,
    )

    const order = render(argumentOf(statement, 'orderBy'))
    assert(
      'newest first, by created_at',
      /"notifications"\."created_at" desc/i.test(order.sql),
      order.sql,
    )

    /*
     * A NULL BODY SURVIVES THE READ. The projection is passed through unchanged,
     * so this is the whole distance between the column and the component.
     */
    check('a body-less notification keeps its null body', list[0]?.body, null)
    check('and a notification with a body keeps it', list[1]?.body, 'Your saved item returned.')
    check(
      'the view carries no owner id for anything to read or send back',
      Object.keys(list[0] ?? {}).sort(),
      ['body', 'createdAt', 'id', 'readAt', 'title'],
    )
  }

  {
    recorder.reset()
    recorder.setRows([{ count: 3 }])

    const unread = await queries.countUnreadNotificationsForOwner(OWNER_B)
    const statement = onlyStatement(recorder.statements, 'countUnreadNotificationsForOwner')

    check('the count is one SELECT', methodsOf(statement), ['select', 'from', 'where'])
    assert(
      'it counts rather than fetching rows to count',
      /count\(\*\)/i.test(render((argumentOf(statement, 'select') as { count?: unknown })?.count).sql),
    )

    const where = render(argumentOf(statement, 'where'))
    assert('scoped by user_id', where.sql.includes('"notifications"."user_id" = $1'), where.sql)
    assert(
      'and restricted to unread rows',
      where.sql.includes('"notifications"."read_at" is null'),
      where.sql,
    )
    check('bound to the owner asked for', where.params, [OWNER_B])
    check('the count is returned as a number', unread, 3)
  }

  {
    recorder.reset()
    recorder.setRows([])
    check('an owner with no unread rows counts zero', await queries.countUnreadNotificationsForOwner(OWNER_A), 0)
  }

  {
    /* A read that wrote would be the worst kind of surprise. */
    recorder.reset()
    recorder.setRows([])
    await queries.listNotificationsForOwner(OWNER_A)
    await queries.countUnreadNotificationsForOwner(OWNER_A)
    check(
      'neither read issues anything but a SELECT',
      recorder.statements.map((statement) => statement[0]?.method),
      ['select', 'select'],
    )
  }

  console.log('\n-- marking one notification read -----------------------')

  {
    recorder.reset()
    recorder.setRows([{ id: NOTIFICATION }])

    const marked = await queries.markNotificationReadForOwner(OWNER_A, NOTIFICATION)
    const statement = onlyStatement(recorder.statements, 'markNotificationReadForOwner')

    check('it is one UPDATE', methodsOf(statement), ['update', 'set', 'where', 'returning'])
    check('a matched row reports success', marked, true)

    const where = render(argumentOf(statement, 'where'))
    assert(
      'the row is addressed by id',
      where.sql.includes('"notifications"."id" = $1'),
      where.sql,
    )
    assert(
      'AND by owner — this is the clause that makes it not an IDOR',
      where.sql.includes('"notifications"."user_id" = $2'),
      where.sql,
    )
    check('bound to the notification and the owner, in that order', where.params, [
      NOTIFICATION,
      OWNER_A,
    ])

    const set = (argumentOf(statement, 'set') ?? {}) as Record<string, unknown>
    check('it writes read_at and updated_at, and nothing else', Object.keys(set).sort(), [
      'readAt',
      'updatedAt',
    ])

    const readAt = render(set.readAt)
    assert(
      'read_at is COALESCE-preserved, so a second mark does not move it',
      /coalesce\(/i.test(readAt.sql) && readAt.sql.includes('"notifications"."read_at"'),
      readAt.sql,
    )
    assert(
      'and the timestamp comes from the database clock',
      /now\(\)/i.test(readAt.sql),
      readAt.sql,
    )
    assert(
      'updated_at moves on every matched write',
      set.updatedAt instanceof Date,
      String(set.updatedAt),
    )
  }

  {
    /*
     * IDEMPOTENCE. Marking the same notification twice issues the identical
     * statement — the `coalesce` is what makes the second one a no-op, rather
     * than some caller remembering not to send it.
     */
    recorder.reset()
    recorder.setRows([{ id: NOTIFICATION }])
    await queries.markNotificationReadForOwner(OWNER_A, NOTIFICATION)
    const first = recorder.statements[0] ?? []

    recorder.reset()
    recorder.setRows([{ id: NOTIFICATION }])
    const second = await queries.markNotificationReadForOwner(OWNER_A, NOTIFICATION)

    check(
      'a repeated mark issues the same statement',
      render(argumentOf(recorder.statements[0] ?? [], 'where')),
      render(argumentOf(first, 'where')),
    )
    check('and reports the same result', second, true)
  }

  {
    /*
     * INDISTINGUISHABLE, and that is the point: "not yours" and "no such thing"
     * are one answer, so an id cannot be used to ask whether an account owns it.
     */
    recorder.reset()
    recorder.setRows([])
    const foreign = await queries.markNotificationReadForOwner(OWNER_A, FOREIGN_NOTIFICATION)
    const foreignStatement = recorder.statements[0] ?? []

    recorder.reset()
    recorder.setRows([])
    const absent = await queries.markNotificationReadForOwner(OWNER_A, UNKNOWN_NOTIFICATION)
    const unknownStatement = recorder.statements[0] ?? []

    check('someone else’s notification does not match', foreign, false)
    check('a notification that does not exist does not match either', absent, false)
    check(
      'and the two are the same statement but for the id',
      render(argumentOf(foreignStatement, 'where')).sql,
      render(argumentOf(unknownStatement, 'where')).sql,
    )
    check(
      'neither carries an account other than the caller',
      [
        render(argumentOf(foreignStatement, 'where')).params[1],
        render(argumentOf(unknownStatement, 'where')).params[1],
      ],
      [OWNER_A, OWNER_A],
    )
  }

  console.log('\n-- marking everything read -----------------------------')

  {
    recorder.reset()
    recorder.setRows([{ id: NOTIFICATION }, { id: FOREIGN_NOTIFICATION }])

    const marked = await queries.markAllNotificationsReadForOwner(OWNER_B)
    const statement = onlyStatement(recorder.statements, 'markAllNotificationsReadForOwner')

    check('it is one UPDATE', methodsOf(statement), ['update', 'set', 'where', 'returning'])
    check('it reports how many rows it marked', marked, 2)

    const where = render(argumentOf(statement, 'where'))
    assert('scoped by user_id', where.sql.includes('"notifications"."user_id" = $1'), where.sql)
    assert(
      'and restricted to unread rows, so read_at is never rewritten',
      where.sql.includes('"notifications"."read_at" is null'),
      where.sql,
    )
    check('bound to the caller and nobody else', where.params, [OWNER_B])

    const set = (argumentOf(statement, 'set') ?? {}) as Record<string, unknown>
    check('it writes read_at and updated_at, and nothing else', Object.keys(set).sort(), [
      'readAt',
      'updatedAt',
    ])
    assert(
      'from the database clock',
      /now\(\)/i.test(render(set.readAt).sql),
      render(set.readAt).sql,
    )
    assert('and updated_at moves', set.updatedAt instanceof Date, String(set.updatedAt))
  }

  {
    recorder.reset()
    recorder.setRows([])
    check(
      'a second run finds nothing unread and marks nothing',
      await queries.markAllNotificationsReadForOwner(OWNER_B),
      0,
    )
  }

  console.log('\n-- the public API takes no identity --------------------')

  const queriesModule = readModule(QUERIES)
  const actionsModule = readModule(ACTIONS)

  assert(
    'queries.ts is server-only',
    queriesModule.sideEffectImports.includes('server-only'),
    'without it, a Client Component importing this is a leak rather than a build error',
  )
  check('actions.ts is a Server Action module', actionsModule.directive, 'use server')
  assert(
    'queries.ts is NOT one — its owner-scoped exports would become endpoints',
    queriesModule.directive !== 'use server',
    'a `use server` directive here publishes markNotificationReadForOwner(ownerId, …) to the internet',
  )

  {
    const list = functionOf(queriesModule, 'getMyNotifications')
    const count = functionOf(queriesModule, 'getUnreadNotificationCount')

    check('getMyNotifications() declares no parameters', [...list.parameters], [])
    check('getUnreadNotificationCount() declares no parameters', [...count.parameters], [])
    check('and the list is typed as the view', list.returnType, 'Promise<NotificationView[]>')

    /*
     * The view type mirrors the columns rather than smoothing them over: a
     * notification may have no body and an unread one has no `readAt`, and both
     * facts have to survive the trip to the component that renders them.
     */
    assert(
      'NotificationView.body is string | null',
      /body: string \| null/.test(queriesModule.code),
      queriesModule.code.slice(0, 200),
    )
    assert(
      'and readAt is Date | null — unread is the absence of a timestamp',
      /readAt: Date \| null/.test(queriesModule.code),
      queriesModule.code.slice(0, 200),
    )

    /*
     * THE FAIL-CLOSED SHAPE, PINNED. Identity is resolved first, the anonymous
     * answer is an empty literal, and the owner-scoped call is reached only
     * afterwards with an id that came from the session. Whitespace is collapsed
     * before comparing, so formatting is free and the token order is not.
     */
    check(
      'anonymous callers get [] before anything touches the database',
      list.body,
      '{ const user = await getCurrentUser() if (!user) return [] return listNotificationsForOwner(user.id) }',
    )
    check(
      'anonymous callers count 0 the same way',
      count.body,
      '{ const user = await getCurrentUser() if (!user) return 0 return countUnreadNotificationsForOwner(user.id) }',
    )
  }

  {
    /*
     * EVERY EXPORT OF A `'use server'` MODULE IS A PUBLIC ENDPOINT taking
     * whatever arguments the caller sends. An exported helper accepting an owner
     * id would therefore be "mark any row for any account", published to the
     * internet — so the export list is checked as a whole, re-exports included.
     */
    check(
      'the action module publishes exactly two endpoints',
      [...actionsModule.exportedValues].sort(),
      ['markAllNotificationsReadAction', 'markNotificationReadAction'],
    )
    assert(
      'and re-exports nothing — an owner-scoped helper must not escape into being one',
      !actionsModule.hasReExport,
      'export { markNotificationReadForOwner } from "./queries" would publish an owner id parameter',
    )

    const single = functionOf(actionsModule, 'markNotificationReadAction')
    const all = functionOf(actionsModule, 'markAllNotificationsReadAction')

    check('markNotificationReadAction takes (previousState, formData)', single.parameters.length, 2)
    check('the second parameter is FormData', single.parameterTypes[1], 'FormData')
    check('markAllNotificationsReadAction takes (previousState, formData)', all.parameters.length, 2)
    check('the second parameter is FormData', all.parameterTypes[1], 'FormData')

    for (const action of [single, all]) {
      assert(
        `${action.name} names no account in its parameters`,
        !/user|owner|account/i.test(action.parameters.join(',')),
        action.parameters.join(','),
      )
      assert(
        `${action.name} resolves identity from the session before anything else`,
        action.body.startsWith(
          '{ const user = await getCurrentUser() if (!user) return fail(\'unauthenticated\'',
        ),
        action.body.slice(0, 120),
      )
      assert(
        `${action.name} passes the session id to the owner-scoped write`,
        /ForOwner\(user\.id/.test(action.body),
        action.body,
      )
    }

    check(
      'the individual mark accepts exactly one field, and it is not an identity',
      zodObjectKeys(actionsModule, 'markNotificationReadSchema'),
      ['notificationId'],
    )
    assert(
      'mark-all reads no form field at all',
      !/formData/.test(all.body),
      'there is no field it could take that would not say whose notifications to clear',
    )

    /*
     * The boundary delegates every row it touches. No `db`, no drizzle, no
     * predicate assembled beside a session lookup — which is what keeps the
     * `user_id` clause in one place instead of two that can drift.
     */
    assert(
      'the boundary owns no SQL of its own',
      !actionsModule.imports.some((specifier) => /^drizzle-orm|@\/lib\/db$/.test(specifier)),
      actionsModule.imports.join(', '),
    )
    assert(
      'and never names a user id it did not resolve itself',
      !/\buserId\b|\bownerId\b|user_id/.test(actionsModule.code),
      'the only identity in this file is `user.id`, from getCurrentUser()',
    )
  }

  {
    /*
     * The owner-scoped functions are the only things that take an id, and they
     * live outside the `'use server'` module for exactly that reason.
     */
    const ownerScoped = queriesModule.functions
      .filter((entry) => entry.name.endsWith('ForOwner'))
      .map((entry) => entry.name)
      .sort()

    check(
      'the owner-scoped layer is these four functions',
      ownerScoped,
      [
        'countUnreadNotificationsForOwner',
        'listNotificationsForOwner',
        'markAllNotificationsReadForOwner',
        'markNotificationReadForOwner',
      ],
    )
    for (const name of ownerScoped) {
      const fn = functionOf(queriesModule, name)
      check(`${name} takes the owner id first`, fn.parameters[0], 'ownerId')
      assert(
        `${name} binds it to notifications.userId`,
        fn.body.includes('eq(schema.notifications.userId, ownerId)'),
        fn.body,
      )
    }

    /*
     * AND NOBODY ELSE MAY CALL THEM. A page that reached for
     * `listNotificationsForOwner(...)` would be one `searchParams` away from
     * reading somebody else's notifications, and it would compile. The only
     * permitted call sites are the two public reads in this module and the two
     * actions, which is the property scanned for here.
     *
     * THIS FILE IS EXEMPT AND SAYS SO: the checks above call these functions by
     * name, which is exactly the vocabulary being forbidden elsewhere.
     */
    const permitted = new Set([QUERIES, ACTIONS, THIS_FILE])
    const trespassers = sourceFiles().filter((file) => {
      if (permitted.has(file)) return false
      return /\w+ForOwner\s*\(/.test(stripComments(readFileSync(join(ROOT, file), 'utf8')))
    })

    check(
      'no file outside the notification module calls an owner-scoped function',
      trespassers,
      [],
    )
  }

  console.log(
    failures === 0
      ? '\nAll notification checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((error: unknown) => {
  /* A thrown check is a failed check, not a passed run with a stack trace. */
  console.log(
    'FAIL  the verification itself threw\n' +
      `        ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  )
  process.exitCode = 1
})
