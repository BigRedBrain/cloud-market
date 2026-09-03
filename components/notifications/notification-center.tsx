'use client'

import { useActionState } from 'react'
import { BellOff, Check, CheckCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '@/lib/notifications/actions'
import type { ActionResult } from '@/lib/result'

/**
 * The notification centre.
 *
 * Every control is a real `<form>` posting a Server Action, so the whole screen
 * works with JavaScript disabled — marking one read and marking everything read
 * are both plain submissions. `useActionState` layers inline feedback on top
 * once hydrated; it is an enhancement, not a requirement.
 *
 * WHAT THE FORMS CARRY IS THE POINT. The per-notification form carries a
 * notification id and NOTHING ELSE. The mark-all form carries nothing at all —
 * not a user id, not a hidden "scope", not a list of ids to sweep. There is no
 * field in either form that names a person, so a tampered payload has nothing
 * to point at someone else's rows: the actions resolve the owner from the
 * session and scope their WHERE clause to it.
 *
 * That is also why an id from another account is not an error worth reporting
 * separately. It matches nothing under `WHERE id = ? AND user_id = <session>`,
 * which is the same outcome as an id that never existed — the two are
 * deliberately indistinguishable from out here.
 *
 * READ AND UNREAD ARE NOT A COLOUR. Each row carries the word, in a badge, and
 * an unread row is the only one that offers a "Mark as read" button. A customer
 * reading in greyscale, or with a screen reader, gets the same distinction the
 * sighted reader gets.
 */

/**
 * One notification, as the server hands it over.
 *
 * `body` IS NULLABLE and is rendered only when present — a notification is
 * allowed to be a title on its own, and `null` must never reach the page as the
 * string "null".
 *
 * The timestamps are typed loosely enough to accept either a `Date` (what the
 * driver returns, preserved across the RSC boundary) or an ISO string, because
 * this component's job is to display them, not to decide which one the query
 * layer produces.
 */
export type NotificationItem = {
  id: string
  title: string
  body: string | null
  readAt: Date | string | null
  createdAt: Date | string
}

/** ISO-8601, whichever of the two shapes arrived. */
function iso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString()
}

/**
 * A fixed, locale-independent rendering: `2026-09-02 14:31`.
 *
 * Deliberately NOT `toLocaleString()`. That reads the runtime's locale and time
 * zone, which differ between the server render and the browser render and
 * produce a hydration mismatch on a page whose entire content is timestamps.
 * The machine-readable value is on the `<time>` element for anything that wants
 * to reformat it.
 */
function displayTimestamp(value: Date | string): string {
  return iso(value).replace('T', ' ').slice(0, 16)
}

/** Marks one notification read. The id is the only thing submitted. */
function MarkReadForm({ notificationId, title }: { notificationId: string; title: string }) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    markNotificationReadAction,
    null,
  )

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="notificationId" value={notificationId} />
      {/* The accessible name says what it acts on, not just what it does. */}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Mark “${title}” as read`}
      >
        <Check aria-hidden="true" />
        Mark as read
      </Button>
      {state && !state.ok && (
        <p role="status" className="font-sans text-xs text-flare">
          {state.message}
        </p>
      )}
    </form>
  )
}

/**
 * Marks every unread notification read.
 *
 * SUBMITS NO FIELDS. Not even a count: the action decides for itself which rows
 * belong to the caller and which of those are still unread.
 */
function MarkAllReadForm({ unreadCount }: { unreadCount: number }) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    markAllNotificationsReadAction,
    null,
  )

  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <Button
        type="submit"
        variant="outline"
        aria-label={`Mark all ${unreadCount} unread notifications as read`}
      >
        <CheckCheck aria-hidden="true" />
        Mark all as read
      </Button>
      {state && !state.ok && (
        <p role="status" className="font-sans text-xs text-flare">
          {state.message}
        </p>
      )}
    </form>
  )
}

export function NotificationCenter({
  notifications,
}: {
  notifications: readonly NotificationItem[]
}) {
  const unreadCount = notifications.filter(
    (notification) => notification.readAt === null,
  ).length

  if (notifications.length === 0) {
    return (
      <EmptyState
        icon={<BellOff />}
        title="Nothing to catch up on"
        description="Order updates and account notices land here."
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-data text-sm text-smoke" aria-live="polite">
          {unreadCount === 0
            ? 'All caught up'
            : `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
        </p>

        {/* Offered only when there is something for it to do. */}
        {unreadCount > 0 && <MarkAllReadForm unreadCount={unreadCount} />}
      </div>

      <ul className="flex flex-col gap-3">
        {notifications.map((notification) => {
          const unread = notification.readAt === null

          return (
            <li key={notification.id}>
              <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={unread ? 'ember' : 'smoke'}>
                      {unread ? 'Unread' : 'Read'}
                    </Badge>
                    <time
                      dateTime={iso(notification.createdAt)}
                      className="font-data text-xs text-smoke"
                    >
                      {displayTimestamp(notification.createdAt)}
                    </time>
                  </div>

                  <h2 className="font-poster text-lg leading-tight tracking-tight text-white">
                    {notification.title}
                  </h2>

                  {/* Nullable by contract — absent body renders nothing. */}
                  {notification.body !== null && (
                    <p className="text-sm leading-relaxed text-smoke">
                      {notification.body}
                    </p>
                  )}
                </div>

                {unread && (
                  <MarkReadForm
                    notificationId={notification.id}
                    title={notification.title}
                  />
                )}
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
