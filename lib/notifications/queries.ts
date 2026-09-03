import 'server-only'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { getCurrentUser } from '@/lib/auth/dal'
import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'

/**
 * The notification data layer — server-only, and owner-scoped without exception.
 *
 * TWO KINDS OF FUNCTION LIVE HERE, and the difference is the whole design:
 *
 *   · The `...ForOwner` functions take an owner id and every one of them binds
 *     it into a `user_id` predicate. They are the only place a notification row
 *     is read or written.
 *   · `getMyNotifications()` and `getUnreadNotificationCount()` take NOTHING.
 *     They resolve the session themselves and are the only callers permitted to
 *     decide what an owner id is.
 *
 * NOTHING ANYWHERE ACCEPTS AN OWNER ID FROM A CLIENT. The `...ForOwner`
 * functions are reachable only from server code — `server-only` makes importing
 * this module from a Client Component a build error — and their one production
 * caller is `lib/notifications/actions.ts`, which derives the id from the
 * session cookie and never from the form.
 *
 * WHY THE OWNER-SCOPED WRITES ARE HERE AND NOT IN `actions.ts`. A `'use server'`
 * module may export nothing but Server Actions, and every export of one is a
 * network endpoint the browser can call with arguments of its choosing. Exporting
 * `markNotificationReadForOwner(ownerId, ...)` from there would therefore publish
 * "mark any row belonging to any account" to the internet. Keeping every helper
 * that takes an owner id OUT of the `'use server'` module is what makes that
 * mistake impossible to make by accident. (A future `lib/notifications/core.ts`
 * is the better home for the name; the placement is what matters.)
 *
 * NO PAGINATION, DELIBERATELY. The list is bounded by one customer's own
 * notifications, and a `LIMIT` with no "show older" affordance would silently
 * hide rows that the unread count still counts. Add both together or neither.
 */

/**
 * One notification as the UI sees it.
 *
 * `body` IS NULLABLE, mirroring the column: a notification is allowed to be a
 * title alone, and a view type that promised `string` would either lie or force
 * an empty-string stand-in that the read layer would have to invent.
 *
 * `userId` is deliberately absent. The list is already scoped to the caller, so
 * carrying the owner into a DTO would only create something for a component to
 * read, compare, or send back.
 */
export type NotificationView = {
  id: string
  title: string
  body: string | null
  readAt: Date | null
  createdAt: Date
}

/* -------------------------------------------------------------------------- */
/* Owner-scoped primitives — an owner id in, a `user_id` predicate out         */
/* -------------------------------------------------------------------------- */

/**
 * One owner's notifications, newest first.
 *
 * Ordered by `created_at` alone, which is exactly the shape of the
 * `(user_id, created_at)` index, so the scope and the sort are served by one
 * index rather than by a sort over a filtered scan.
 */
export async function listNotificationsForOwner(
  ownerId: string,
): Promise<NotificationView[]> {
  return db
    .select({
      id: schema.notifications.id,
      title: schema.notifications.title,
      body: schema.notifications.body,
      readAt: schema.notifications.readAt,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, ownerId))
    .orderBy(desc(schema.notifications.createdAt))
}

/**
 * How many of one owner's notifications are unread.
 *
 * `read_at IS NULL` is the definition of unread — there is no stored boolean to
 * drift away from the timestamp. The predicate matches the partial index on
 * `(user_id) WHERE read_at IS NULL`, which is why the bell can afford to be
 * counted on every page render.
 */
export async function countUnreadNotificationsForOwner(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, ownerId),
        isNull(schema.notifications.readAt),
      ),
    )

  return row?.count ?? 0
}

/**
 * Marks one of an owner's notifications read. Returns whether a row matched.
 *
 * BOTH HALVES OF THE PREDICATE ARE LOAD-BEARING. `id` says which row; `user_id`
 * says whose. Without the second, a guessed or leaked id would mark somebody
 * else's notification read — a small harm with a large shape, since it is the
 * same omission that turns any id-addressed mutation into an IDOR.
 *
 * A row belonging to another account and a row that does not exist are the same
 * outcome: no match, `false`, and the caller has one message for both. The
 * alternative — "not yours" versus "no such thing" — is an oracle that turns an
 * id into a membership test.
 *
 * IDEMPOTENT, AND THE `coalesce` IS WHY. Marking an already-read notification
 * keeps the original `read_at` instead of moving it forward, so a double-click,
 * a retried submission and a re-run of the same form all leave the same row.
 * `now()` is evaluated by Postgres, so the recorded time comes from the database
 * clock rather than whichever application server happened to serve the request.
 *
 * `updated_at` still moves on every matched write, including the no-op one: the
 * row was touched, and the auditing column records touches rather than changes.
 */
export async function markNotificationReadForOwner(
  ownerId: string,
  notificationId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.notifications)
    .set(
      withUpdatedAt({
        readAt: sql`coalesce(${schema.notifications.readAt}, now())`,
      }),
    )
    .where(
      and(
        eq(schema.notifications.id, notificationId),
        eq(schema.notifications.userId, ownerId),
      ),
    )
    .returning({ id: schema.notifications.id })

  return rows.length > 0
}

/**
 * Marks every one of an owner's unread notifications read. Returns how many.
 *
 * `read_at IS NULL` in the predicate is what keeps this idempotent and honest:
 * already-read rows are not matched, so their original `read_at` cannot be
 * rewritten and their `updated_at` is not disturbed. A second run touches
 * nothing and returns zero, which is also why this needs no `coalesce` — the
 * rows it can reach are exactly the ones with nothing to preserve.
 *
 * Scoped to one owner, like everything else here. There is no form of this
 * function that marks anything for anybody else.
 */
export async function markAllNotificationsReadForOwner(ownerId: string): Promise<number> {
  const rows = await db
    .update(schema.notifications)
    .set(withUpdatedAt({ readAt: sql`now()` }))
    .where(
      and(
        eq(schema.notifications.userId, ownerId),
        isNull(schema.notifications.readAt),
      ),
    )
    .returning({ id: schema.notifications.id })

  return rows.length
}

/* -------------------------------------------------------------------------- */
/* The public reads — identity is resolved here and nowhere else               */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in customer's notifications, newest first.
 *
 * TAKES NO ARGUMENTS, and that is the security property rather than a
 * convenience: there is no parameter for a page, a component or a request to
 * put somebody else's id into.
 *
 * ANONYMOUS CALLERS GET AN EMPTY LIST, not an error and not a redirect. The
 * navigation renders on public pages for signed-out visitors, and a read that
 * throws there would take the whole page down over a bell. The guard runs before
 * anything touches the database, so an anonymous request issues no query at all.
 */
export async function getMyNotifications(): Promise<NotificationView[]> {
  const user = await getCurrentUser()
  if (!user) return []

  return listNotificationsForOwner(user.id)
}

/**
 * How many notifications the signed-in customer has not read. Zero when nobody
 * is signed in — the same fail-closed shape as the list above, for the same
 * reason: this is read on every render of the customer navigation.
 */
export async function getUnreadNotificationCount(): Promise<number> {
  const user = await getCurrentUser()
  if (!user) return 0

  return countUnreadNotificationsForOwner(user.id)
}
