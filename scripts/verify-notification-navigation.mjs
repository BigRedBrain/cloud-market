/**
 * The notification centre's navigation and identity wiring, proved from source.
 *
 *   node scripts/verify-notification-navigation.mjs
 *
 * HERMETIC BY CONSTRUCTION. No database, no network, no session, no environment
 * variable, no rendering. The only I/O is reading files out of this repository,
 * because every property below is a property OF those files.
 *
 * WHAT THIS IS PROVING. Not that the notification centre renders — that is a
 * browser's job — but five claims that no single file can demonstrate on its
 * own:
 *
 *   1. IDENTITY IS SERVER-DERIVED, NEVER SENT. No caller anywhere passes a user
 *      id to `getMyNotifications()` or `getUnreadNotificationCount()`, because
 *      both are called with empty parentheses everywhere in the tree. The forms
 *      carry the same discipline: the per-notification form submits a
 *      notification id and nothing else, and the mark-all form submits nothing
 *      at all. There is no field for a tampered payload to aim at another
 *      account.
 *   2. THE HEADER STAYS PRESENTATIONAL. `components/site-nav.tsx` is a client
 *      component that imports no DAL, no database and no notification query. It
 *      is told the unread count; it cannot look one up.
 *   3. ANONYMOUS GETS NO BELL AT ALL. The bell is rendered behind an explicit
 *      `typeof … === 'number'` presence test, and the prop defaults to `null`.
 *      A caller that resolves nothing therefore shows nothing — not a bell
 *      reading zero, and not a stale count.
 *   4. THE WRAPPER IS THE ONLY PLACE THE VIEWER IS RESOLVED, and it takes no
 *      user id: it reads the session through the DAL, asks for the count with
 *      no argument, and forwards `bagCount` and `marketplaceEntry` untouched.
 *   5. EVERY CUSTOMER PAGE USES IT, AND `/design` DOES NOT. The page list is
 *      exact, and the design system page is asserted to still render `SiteNav`
 *      directly — it is a component gallery with no viewer, and dragging a
 *      session lookup into it would be the easy accidental change.
 *
 * WHY SOURCE INSPECTION. Each of these is an ABSENCE — no user id parameter, no
 * identity field, no session lookup in the client component, no bell for a
 * viewer who is not there. An absence cannot be tested by calling a function,
 * so it is tested by reading the code, which is also the check that catches a
 * future edit quietly reintroducing one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let passes = 0
let failures = 0
const failed = []

const section = (title) => console.log(`\n${title}`)

function check(name, condition, detail = '') {
  if (condition) {
    passes += 1
  } else {
    failures += 1
    failed.push(name)
  }
  console.log(
    `    ${condition ? 'ok  ' : 'FAIL'}  ${name}` +
      (!condition && detail ? `\n            ${detail}` : ''),
  )
}

/** File contents with line endings normalised, so a CRLF checkout behaves. */
function source(...segments) {
  return readFileSync(join(ROOT, ...segments), 'utf8').replace(/\r\n/g, '\n')
}

/** Source with comments removed, so structural checks read code and not prose. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function code(...segments) {
  return stripComments(source(...segments))
}

/** Every source file in the repository, excluding build output and deps. */
function sourceFiles() {
  const skipDirectories = new Set(['node_modules', 'drizzle'])
  const extensions = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx']
  const found = []

  function walk(directory) {
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

/** The rendered `<CustomerSiteNav …/>` tag, or ''. */
function customerNavTag(body) {
  return body.match(/<CustomerSiteNav\b[^>]*\/>/)?.[0] ?? ''
}

/** Every `<form …>…</form>` block, with the offset it starts at. */
function forms(text) {
  return [...text.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((match) => ({
    text: match[0],
    at: match.index ?? -1,
  }))
}

/** The `name="…"` of every `<input>` inside one form, in document order. */
function submittedFieldNames(formText) {
  return [...formText.matchAll(/<input\b[^>]*>/g)]
    .map((input) => input[0].match(/\bname="([^"]*)"/)?.[1] ?? '')
    .filter(Boolean)
}

/**
 * The first form rendered after `marker` is last mentioned.
 *
 * Both actions are named twice in the module — once in the import, once in the
 * `useActionState` call that binds them — so the LAST mention is the binding,
 * and the form immediately after it is the one that posts to it. This is what
 * lets the assertions below talk about "the mark-all form" without depending on
 * what the component happens to have called its local helpers.
 */
function formBoundTo(text, marker) {
  const boundAt = text.lastIndexOf(marker)
  if (boundAt === -1) return null
  return forms(text).find((form) => form.at > boundAt) ?? null
}

const PAGES = [
  ['app', 'page.tsx'],
  ['app', 'bag', 'page.tsx'],
  ['app', 'checkout', 'review', 'page.tsx'],
  ['app', 'notifications', 'page.tsx'],
  ['app', 'orders', '[number]', 'page.tsx'],
  ['app', 'product', '[slug]', 'page.tsx'],
  ['app', 'shop', 'page.tsx'],
  ['app', 'shop', '[category]', 'page.tsx'],
]

const NAV_PATH = join('components', 'site-nav.tsx')
const WRAPPER_PATH = join('components', 'customer-site-nav.tsx')
const CENTER_PATH = join('components', 'notifications', 'notification-center.tsx')
const NOTIFICATIONS_PAGE_PATH = join('app', 'notifications', 'page.tsx')
const DESIGN_PATH = join('app', 'design', 'page.tsx')

/* This file names every symbol it forbids. It must never scan itself. */
const SELF_PATH = join('scripts', 'verify-notification-navigation.mjs')

function main() {
  section('-- every customer page renders the server wrapper -------')

  for (const segments of PAGES) {
    const path = join(...segments)
    const pageCode = code(...segments)
    const tag = customerNavTag(pageCode)

    check(`${path}: renders <CustomerSiteNav>`, tag.length > 0)
    check(
      `${path}: imports it from @/components/customer-site-nav`,
      /import\s*\{[^}]*\bCustomerSiteNav\b[^}]*\}\s*from\s*['"]@\/components\/customer-site-nav['"]/.test(
        pageCode,
      ),
    )
    check(
      `${path}: renders no bare <SiteNav> of its own`,
      !/<SiteNav\b/.test(pageCode),
      'the wrapper is what resolves the viewer; a bare nav skips it',
    )
    check(
      `${path}: passes no user id to the navigation`,
      !/userId/.test(tag) && !/user\.id/.test(tag),
      `tag: ${tag}`,
    )
  }

  section('-- the design gallery is deliberately excluded ----------')

  {
    /*
     * `/design` is a component gallery with no customer behind it. It renders
     * `SiteNav` directly with a hard-coded bag count, and must keep doing so:
     * giving it the wrapper would put a session lookup and a notification query
     * behind a page whose entire purpose is to render components in isolation.
     */
    const designCode = code('app', 'design', 'page.tsx')

    check(`${DESIGN_PATH}: still renders <SiteNav> directly`, /<SiteNav\b/.test(designCode))
    check(
      `${DESIGN_PATH}: does not use the customer wrapper`,
      !/CustomerSiteNav/.test(designCode),
    )
    check(
      `${DESIGN_PATH}: reads no notifications and resolves no viewer`,
      !/notifications?\//i.test(designCode) &&
        !/getUnreadNotificationCount|getMyNotifications|getCurrentUser|requireUser/.test(
          designCode,
        ),
    )
  }

  section('-- SiteNav stays a client presentation component --------')

  {
    const navSource = source('components', 'site-nav.tsx')
    const navCode = stripComments(navSource)

    check("it declares 'use client'", /^\s*'use client'/.test(navSource))
    check(
      'it does not import server-only',
      !/['"]server-only['"]/.test(navCode),
      'a client component that could import it would not be a client component',
    )
    check(
      'it imports no DAL, no database and no notification module',
      !/from\s+['"][^'"]*lib\/(?:auth\/|db|notifications\/)/.test(navCode),
    )
    check(
      'it resolves no viewer and fetches no count',
      !/\b(?:getCurrentUser|requireUser|getUnreadNotificationCount|getMyNotifications)\b/.test(
        navCode,
      ) && !navCode.includes('fetch('),
      'a header that counted for itself would be counting in the browser',
    )
    check(
      'it is never handed a user id',
      !/\buserId\b/.test(navCode),
      'there is no id prop for a caller to get wrong',
    )

    check(
      'the unread count prop is optional and nullable',
      /\bunreadNotificationCount\?\s*:\s*number\s*\|\s*null/.test(navCode),
      'null is what "there is nobody to count for" looks like in the type',
    )
    check(
      'and it defaults to null, never to a number',
      /unreadNotificationCount\s*=\s*null/.test(navCode) &&
        !/unreadNotificationCount\s*=\s*\d/.test(navCode) &&
        !/unreadNotificationCount\s*(?:\?\?|\|\|)\s*\d/.test(navCode),
      'a numeric default would draw a bell for an unwired caller',
    )

    {
      /*
       * Presence, not truthiness, and the ONLY bell in the file sits behind it.
       * `unreadNotificationCount &&` would render a bare `0`; `> 0 &&` around
       * the link would hide the control from a signed-in customer who is caught
       * up. The badge inside may still test `> 0` — that is the count, not the
       * bell — so the assertion is about ordering and uniqueness rather than
       * about banning the comparison outright.
       */
      const presenceAt = navCode.search(
        /typeof\s+unreadNotificationCount\s*===\s*['"]number['"]/,
      )
      const bells = [...navCode.matchAll(/href="\/notifications"/g)]
      const bellAt = bells[0]?.index ?? -1

      check(
        'the bell is guarded by an explicit typeof === number test',
        presenceAt >= 0,
        'no presence test found — the bell is chosen some other way',
      )
      check(
        'exactly one notification control exists in the header',
        bells.length === 1,
        `${bells.length} found — a second one would not be covered by the test above`,
      )
      check(
        'and it is rendered only after that test',
        presenceAt >= 0 && bellAt > presenceAt,
        `presence test at ${presenceAt}, bell at ${bellAt}`,
      )
      check(
        'the count is not used as a truthiness test for the control',
        !/unreadNotificationCount\s*&&/.test(navCode),
        '`count &&` renders a literal 0 when the customer is caught up',
      )
      check(
        'the count reaches the accessible name, not only the badge',
        /aria-label=\{`Notifications, \$\{unreadNotificationCount\}/.test(navCode),
        'a number that exists only as a coloured chip is announced to nobody',
      )
    }
  }

  section('-- CustomerSiteNav derives the viewer on the server -----')

  {
    const wrapperSource = source('components', 'customer-site-nav.tsx')
    const wrapperCode = stripComments(wrapperSource)

    check("it is a Server Component — no 'use client'", !/'use client'/.test(wrapperSource))
    check("it imports 'server-only'", /['"]server-only['"]/.test(wrapperCode))
    check(
      'it resolves the viewer through the DAL',
      /\bgetCurrentUser\s*\(\s*\)/.test(wrapperCode) &&
        /from\s+['"]@\/lib\/auth\/dal['"]/.test(wrapperCode),
    )
    check(
      'it accepts no user id, from a prop or otherwise',
      !/\buserId\b/.test(wrapperCode),
      'the viewer is read from the session; there is nothing for a page to pass',
    )
    check(
      'it asks for the unread count with NO arguments',
      /\bgetUnreadNotificationCount\s*\(\s*\)/.test(wrapperCode) &&
        !/\bgetUnreadNotificationCount\s*\(\s*[^)\s]/.test(wrapperCode),
    )

    {
      /*
       * Anonymous is answered with `null` rather than with a number, and the
       * value being tested has to be the resolved viewer — matched by shape, so
       * the local may be called anything.
       */
      const branch = wrapperCode.match(
        /([A-Za-z_$][\w$]*)\s*\?\s*await\s+getUnreadNotificationCount\s*\(\s*\)\s*:\s*null/,
      )

      check(
        'anonymous is passed null, not 0 and not a stale number',
        branch !== null,
        'no `<viewer> ? await getUnreadNotificationCount() : null` found',
      )
      check(
        'and the value it branches on is the viewer read from the session',
        branch !== null &&
          new RegExp(
            `\\b(?:const|let)\\s+${branch[1]}\\s*=\\s*await\\s+getCurrentUser\\s*\\(`,
          ).test(wrapperCode),
        `branches on: ${branch?.[1] ?? '(none)'}`,
      )
    }

    check(
      'it delegates rendering to SiteNav',
      /<SiteNav\b/.test(wrapperCode),
      'presentation stays in the client component',
    )
    check(
      'it forwards bagCount unchanged',
      /bagCount=\{\s*bagCount\s*\}/.test(wrapperCode),
    )
    check(
      'it forwards marketplaceEntry unchanged',
      /marketplaceEntry=\{\s*marketplaceEntry\s*\}/.test(wrapperCode),
    )
    check(
      'and hands the resolved count straight down',
      /unreadNotificationCount=\{\s*unreadNotificationCount\s*\}/.test(wrapperCode),
    )
    check(
      'it enforces no marketplace membership of its own',
      !/\brequireMarketplaceAccess\s*\(/.test(wrapperCode),
      'membership belongs to the route that reads private data',
    )
  }

  section('-- the notifications page authenticates, then reads -----')

  {
    const pageCode = code('app', 'notifications', 'page.tsx')

    const authAt = pageCode.search(/\brequireUser\s*\(/)
    const readAt = pageCode.search(/\bgetMyNotifications\s*\(/)

    check('it requires a signed-in user', authAt >= 0)
    check(
      'and does so BEFORE it reads any notification',
      authAt >= 0 && readAt >= 0 && authAt < readAt,
      `requireUser() at ${authAt}, getMyNotifications() at ${readAt}`,
    )
    check(
      'it lists notifications with NO identity argument',
      /\bgetMyNotifications\s*\(\s*\)/.test(pageCode) &&
        !/\bgetMyNotifications\s*\(\s*[^)\s]/.test(pageCode),
      'the owner is the session, not a parameter',
    )
    check(
      'it reads them from the server-only query module',
      /from\s+['"]@\/lib\/notifications\/queries['"]/.test(pageCode),
    )
    check(
      'it renders the notification centre',
      /<NotificationCenter\b/.test(pageCode),
    )
    check(
      'it passes no user id to the centre or to the navigation',
      !/userId=/.test(pageCode) && !/user\.id\}/.test(pageCode),
      'the bag count is the only thing the resolved user is used for',
    )
  }

  section('-- the forms carry no identity --------------------------')

  {
    const centerSource = source('components', 'notifications', 'notification-center.tsx')
    const centerCode = stripComments(centerSource)

    check("the centre is a client component", /^\s*'use client'/.test(centerSource))
    check(
      'it posts to the server actions, not to a hand-rolled endpoint',
      /from\s+['"]@\/lib\/notifications\/actions['"]/.test(centerCode) &&
        !centerCode.includes('fetch('),
    )
    check(
      'it imports no DAL and no database',
      !/from\s+['"][^'"]*lib\/(?:auth\/|db)/.test(centerCode),
      'a client component reading the session reads it in the browser',
    )
    check(
      'the word userId appears nowhere in it',
      !/\buserId\b/.test(centerCode),
    )

    const individual = formBoundTo(centerCode, 'markNotificationReadAction')
    const markAll = formBoundTo(centerCode, 'markAllNotificationsReadAction')

    check('the per-notification form was found', individual !== null)
    check(
      'it submits exactly one field, the notification id',
      individual !== null &&
        JSON.stringify(submittedFieldNames(individual.text)) ===
          JSON.stringify(['notificationId']),
      `fields: ${JSON.stringify(individual ? submittedFieldNames(individual.text) : null)}`,
    )
    check(
      'and its id comes from the rendered row, not from anything typed',
      individual !== null &&
        /name="notificationId"\s+value=\{\s*notificationId\s*\}/.test(individual.text),
    )
    check(
      'it names what it acts on, for a screen reader',
      individual !== null && /aria-label=/.test(individual.text),
    )

    check('the mark-all form was found', markAll !== null)
    check(
      'it submits NOTHING — no user id, no scope, no list of ids',
      markAll !== null && submittedFieldNames(markAll.text).length === 0,
      `fields: ${JSON.stringify(markAll ? submittedFieldNames(markAll.text) : null)}`,
    )
    check(
      'and it is a real submit button with an accessible name',
      markAll !== null &&
        /type="submit"/.test(markAll.text) &&
        /aria-label=/.test(markAll.text),
      'both controls stay plain form submissions, so they work without JavaScript',
    )

    check(
      'read and unread are distinguished by the read timestamp',
      /readAt\s*===\s*null/.test(centerCode),
      'a row is unread when it has no readAt, not because of how it is styled',
    )
    check(
      'the state is rendered as a word, not only as a colour',
      /Unread/.test(centerCode) && /Read/.test(centerCode),
    )
    check(
      'a null body is handled explicitly',
      /\bbody\s*(?:!==\s*null|&&)/.test(centerCode),
      'body is nullable; it must never reach the page as the string "null"',
    )
    check(
      'the body type admits null',
      /\bbody:\s*string\s*\|\s*null/.test(centerCode),
    )
  }

  section('-- no caller anywhere sends a user id -------------------')

  {
    /*
     * The tree-wide sweep, and the load-bearing one. Everything above is about
     * the files this slice wrote; this is about every file that could call
     * them, now or later. Both reads take no identity, so a call with ANY
     * argument is the change worth failing on — whether it is a user id, a
     * session, or an "options" bag that grows one.
     */
    const files = sourceFiles()

    check(
      'the tree scan actually found files',
      files.length > 50,
      `only ${files.length} scanned — a scan that finds nothing passes everything`,
    )

    const argumentBearingCalls = []
    const countCallers = []
    const listCallers = []

    for (const file of files) {
      const path = relative(ROOT, file)

      /*
       * `scripts/` is skipped wholesale, this file included. A verification
       * script proves things about a symbol by quoting it — including the
       * forbidden spellings — and a scan that reads the police report as
       * evidence of the crime reports whatever it was written to look for.
       */
      if (path.startsWith(`scripts${sep}`) || path === SELF_PATH) continue

      const text = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))

      for (const name of ['getMyNotifications', 'getUnreadNotificationCount']) {
        const call = new RegExp(`\\b${name}\\s*\\(\\s*([^)\\s])`)
        if (call.test(text)) argumentBearingCalls.push(`${path}: ${name}`)
      }

      /* Callers are counted from the call, not the import; `lib/` defines them. */
      if (path.startsWith(`lib${sep}`)) continue

      if (/\bgetUnreadNotificationCount\s*\(/.test(text)) countCallers.push(path)
      if (/\bgetMyNotifications\s*\(/.test(text)) listCallers.push(path)
    }

    check(
      'neither notification read is ever called with an argument',
      argumentBearingCalls.length === 0,
      argumentBearingCalls.join(', '),
    )
    check(
      'the unread count is read by the navigation wrapper and nowhere else',
      JSON.stringify(countCallers.sort()) === JSON.stringify([WRAPPER_PATH]),
      `callers: ${countCallers.join(', ') || '(none)'}`,
    )
    check(
      'the list is read by the notifications page and nowhere else',
      JSON.stringify(listCallers.sort()) === JSON.stringify([NOTIFICATIONS_PAGE_PATH]),
      `callers: ${listCallers.join(', ') || '(none)'}`,
    )

    /* Named explicitly as well, so the report says which file held the line. */
    for (const path of [NAV_PATH, CENTER_PATH]) {
      check(
        `${path}: never reads notifications for itself`,
        !/\bgetUnreadNotificationCount\s*\(|\bgetMyNotifications\s*\(/.test(
          stripComments(readFileSync(join(ROOT, path), 'utf8')),
        ),
        'a client component asking for its own count asks from the browser',
      )
    }
  }

  console.log(
    `\n${failures === 0 ? 'OK' : 'FAILED'} — ${passes} passing, ${failures} failing assertion(s)` +
      (failures === 0 ? '\n' : `\n  ${failed.join('\n  ')}\n`),
  )
  process.exit(failures === 0 ? 0 : 1)
}

main()
