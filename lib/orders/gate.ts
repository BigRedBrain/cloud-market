import 'server-only'

import { lastSuccessfulSweep } from '@/lib/jobs/sweep'

/**
 * The checkout kill switch, and the conditions checkout refuses to run under.
 *
 * DEFAULTS TO OFF. An absent `CHECKOUT_ENABLED` means disabled, not enabled —
 * a feature that turns itself on when an environment variable goes missing is
 * not a kill switch, it is a fuse that only blows the wrong way. The value must
 * be the literal string `true`; anything else, including `1`, `yes` and `TRUE`,
 * reads as off, because a switch on a legal boundary should not have a
 * permissive parser.
 *
 * WHAT IT DOES AND DOES NOT STOP
 *
 * Disabled, the storefront still works: browsing, the bag, accounts, order
 * history, and every staff fulfilment operation. Only DRAFT CREATION and ORDER
 * PLACEMENT are refused. Taking the shop offline because it cannot yet take a
 * new order would be a far worse failure than the one being prevented — a
 * customer with a placed order still needs to see it, and staff still need to
 * hand it over and take the cash.
 *
 * The same reasoning governs the staleness gate below: a scheduler outage stops
 * NEW drafts and nothing else.
 */

/** How stale the sweeper may be before new drafts are refused. */
export const MAX_SWEEP_AGE_SECONDS = 900

export type CheckoutGate =
  | { open: true }
  | { open: false; reason: 'disabled' }
  | { open: false; reason: 'sweeper_stale'; ageSeconds: number | null }

/**
 * Is the flag on?
 *
 * Read from `process.env` at call time rather than captured at module scope, so
 * a deployment that changes it takes effect on the next request instead of the
 * next cold start.
 */
export function checkoutEnabled(): boolean {
  return process.env.CHECKOUT_ENABLED === 'true'
}

/**
 * May a new draft or placement proceed?
 *
 * ORDER OF CHECKS MATTERS. The flag is first and cheapest: when checkout is
 * switched off there is no reason to query the scheduler, and a preflight
 * environment with no scheduler running should report "disabled" rather than
 * "stale", which is the more accurate answer and the less alarming one.
 *
 * 900 seconds is `RESERVATION_TTL_MINUTES` in seconds, deliberately. Once a
 * full reservation window has elapsed with no sweep, there may be expired holds
 * that nothing has released — so the stock figures new drafts would be reserved
 * against are no longer trustworthy. Refusing is the conservative direction:
 * the alternative is promising a customer an item that is already spoken for.
 */
export async function checkoutGate(): Promise<CheckoutGate> {
  if (!checkoutEnabled()) return { open: false, reason: 'disabled' }

  /**
   * A scheduler probe that throws must not take checkout down with it — that
   * would turn a reporting failure into an outage. An unreadable signal is
   * treated as stale, which refuses new drafts and leaves everything else
   * working, exactly as a genuine staleness would.
   */
  let last: Awaited<ReturnType<typeof lastSuccessfulSweep>> = null
  try {
    last = await lastSuccessfulSweep()
  } catch (error) {
    console.error('[gate] scheduler probe failed:', error)
    return { open: false, reason: 'sweeper_stale', ageSeconds: null }
  }

  if (!last) return { open: false, reason: 'sweeper_stale', ageSeconds: null }

  const ageSeconds = Math.round((Date.now() - last.at.getTime()) / 1000)
  if (ageSeconds > MAX_SWEEP_AGE_SECONDS) {
    return { open: false, reason: 'sweeper_stale', ageSeconds }
  }

  return { open: true }
}

/** Customer-facing text. Never names an environment variable. */
export function describeGate(gate: Extract<CheckoutGate, { open: false }>): string {
  switch (gate.reason) {
    case 'disabled':
      return 'Online ordering is not open yet. You can browse and build a bag, and we will let you know as soon as checkout goes live.'
    case 'sweeper_stale':
      return 'We cannot start a new checkout right now while we confirm stock levels. Please try again in a few minutes, or call the store.'
  }
}
