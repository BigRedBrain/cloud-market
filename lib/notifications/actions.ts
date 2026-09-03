'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getCurrentUser } from '@/lib/auth/dal'
import {
  markAllNotificationsReadForOwner,
  markNotificationReadForOwner,
} from '@/lib/notifications/queries'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'

/**
 * Notification mutations.
 *
 * EVERY EXPORT OF A `'use server'` MODULE IS A PUBLIC NETWORK ENDPOINT, callable
 * with whatever arguments the caller likes. That is the fact these two actions
 * are shaped around:
 *
 *   · The input contract is one field — `notificationId` — for the individual
 *     mark, and nothing at all for the mark-all. There is no `userId` field to
 *     omit checking, because there is no `userId` field.
 *   · Identity comes from `getCurrentUser()`, which reads the session cookie.
 *     A form that posts an extra `userId` is not refused so much as ignored:
 *     `parseInput` returns only what the schema names, and the schema does not
 *     name it.
 *   · The owner-scoped work lives in `@/lib/notifications/queries`, deliberately
 *     outside this module, because a helper here that took an owner id would
 *     itself become an endpoint accepting one. Nothing in this file may export
 *     anything but these two actions.
 *
 * AUTHENTICATION RUNS BEFORE THE INPUT IS USED, matching the rest of the
 * application's actions: an anonymous request is answered by the guard, not by a
 * validation message about a field it was never entitled to submit.
 */

/**
 * The entire domain input.
 *
 * `z.uuid()` rejects anything that is not a well-formed id before it reaches the
 * database — a `uuid` column would otherwise turn a malformed value into a
 * driver error rather than a validation failure. It is NOT an ownership check:
 * a perfectly well-formed id belonging to somebody else gets exactly as far as
 * the `user_id` predicate in the update, and no further.
 */
const markNotificationReadSchema = z.object({
  notificationId: z.uuid('Unknown notification'),
})

/** Sign-in prompt. One string for both actions, since the situation is one. */
const SIGN_IN_REQUIRED = 'Please sign in to see your notifications.'

/**
 * Refreshes the notification page and the navigation.
 *
 * `'layout'` is what re-renders the unread bell, which is drawn by the customer
 * navigation on every storefront page rather than only on `/notifications` —
 * without it the count a customer just cleared would stay on screen until
 * something else happened to invalidate the page.
 */
function revalidateNotifications() {
  revalidatePath('/notifications')
  revalidatePath('/', 'layout')
}

/**
 * Marks one notification read.
 *
 * The failure for "not yours" and the failure for "no such notification" are the
 * same string, because the underlying write cannot tell them apart and must not
 * be made able to: a distinguishable answer would let anyone with an id learn
 * whether it belongs to somebody.
 *
 * Marking an already-read notification succeeds and changes nothing meaningful —
 * see the `coalesce` in `markNotificationReadForOwner`. A double submission is
 * therefore not an error state the form has to explain.
 */
export async function markNotificationReadAction(
  _previousState: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return fail('unauthenticated', SIGN_IN_REQUIRED)

  const parsed = parseInput(markNotificationReadSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const marked = await markNotificationReadForOwner(user.id, parsed.data.notificationId)
  if (!marked) return fail('not_found', 'That notification is no longer available.')

  revalidateNotifications()
  return ok()
}

/**
 * Marks every one of the caller's unread notifications read.
 *
 * `formData` IS ACCEPTED AND NEVER READ. The parameter exists because
 * `useActionState` passes one, and the body deliberately contains no
 * `formData.get(...)`: there is no field this action could take that would not
 * be an attempt to say whose notifications to clear.
 *
 * Succeeds when there was nothing to mark. "Everything is read" is the state the
 * customer asked for, and reporting it as a failure would be a dialog about
 * nothing.
 */
export async function markAllNotificationsReadAction(
  _previousState: ActionResult<void> | null,
  _formData: FormData,
): Promise<ActionResult<void>> {
  const user = await getCurrentUser()
  if (!user) return fail('unauthenticated', SIGN_IN_REQUIRED)

  await markAllNotificationsReadForOwner(user.id)

  revalidateNotifications()
  return ok()
}
