import 'server-only'

import type { PaymentIntentStatus, PaymentProvider } from '@/lib/db/schema'

/**
 * The payment provider seam.
 *
 * Checkout and order logic depend on THIS interface and never on a concrete
 * provider. That is what makes the choice of processor reversible: swapping
 * BTCPay for Coinbase Commerce is a new file implementing these five methods,
 * not a rewrite of order finalisation.
 *
 * WHY THE SEAM IS HERE AND NOT LOWER. The tempting alternative is a thin HTTP
 * client per provider with the business logic above it. That leaks provider
 * concepts upward — one calls it an invoice, another a charge, one settles in
 * satoshis, another in a decimal string — and the "provider-agnostic" layer ends
 * up full of conditionals. So the adapter's job is TRANSLATION: it converts the
 * provider's vocabulary into the vocabulary of `payment_intents`, and nothing
 * above it ever sees the difference.
 *
 * WHAT AN ADAPTER MUST NEVER DO
 *
 *  - Trust anything the browser sent. Confirmation comes from the provider over
 *    a signed channel, or it does not come at all (section AE).
 *  - Write to `orders`. Adapters return facts; `lib/payments/intents.ts` decides
 *    what those facts mean and moves the order inside a transaction.
 *  - Return an unverified webhook payload. `verifyWebhook` either authenticates
 *    the request or rejects it; there is no "probably fine" return value.
 */

/** Money owed, in the fiat currency of record. Integer cents, as everywhere. */
export type FiatAmount = {
  cents: number
  currency: string
}

/**
 * What an adapter returns after creating an invoice.
 *
 * `cryptoAmount` and `exchangeRate` are STRINGS, not numbers. They land in
 * `numeric(38, 18)` columns, and passing them through a JavaScript float would
 * reintroduce exactly the rounding error `lib/money.ts` exists to prevent — on
 * values where the error is somebody's money. The provider sends a decimal
 * string; it stays a decimal string all the way to Postgres.
 */
export type CreatedPayment = {
  providerReference: string
  paymentAddress: string | null
  cryptoCurrency: string
  cryptoNetwork: string
  cryptoAmount: string
  exchangeRate: string
  quoteExpiresAt: Date
}

/**
 * The provider's view of a payment, normalised.
 *
 * `amountReceived` is the total observed so far, not a delta — deltas require
 * the receiver to track what it has already seen, and a missed or duplicated
 * event then corrupts the running total permanently. An absolute figure is
 * idempotent by construction: applying the same event twice yields the same
 * number.
 */
export type ProviderPaymentStatus = {
  status: PaymentIntentStatus
  amountReceived: string | null
  /** Provider's own failure vocabulary, for the audit trail. */
  failureCode?: string | null
}

/**
 * A webhook that has been cryptographically verified.
 *
 * An adapter returns this ONLY after checking the signature. The `payload` is
 * safe to persist at that point, and not before — an unverified payload is
 * attacker-controlled data, and storing it verbatim would make `payment_events`
 * a place to park whatever an attacker wanted us to keep.
 */
export type VerifiedWebhook = {
  /** The provider's event id. THE IDEMPOTENCY KEY — see `payment_events`. */
  providerEventId: string
  eventType: string
  /** Links back to `payment_intents.provider_reference`. */
  providerReference: string
  /** The provider's signed timestamp, for replay rejection. */
  providerTimestamp: Date | null
  status: ProviderPaymentStatus
  /** Credential-scrubbed by the adapter before it gets here. */
  payload: unknown
}

export type WebhookRejection = {
  ok: false
  /**
   * Recorded in `payment_events.rejection_reason` and audited. Deliberately
   * coarse: a caller that could distinguish "bad signature" from "unknown
   * reference" in its RESPONSE would be an oracle for which references exist.
   * The distinction is kept server-side only.
   */
  reason:
    | 'bad_signature'
    | 'malformed'
    | 'stale_timestamp'
    | 'unknown_reference'
    | 'not_configured'
}

export type WebhookResult = { ok: true; event: VerifiedWebhook } | WebhookRejection

/**
 * The five operations, per section AH.
 */
export type PaymentProviderAdapter = {
  readonly id: PaymentProvider

  /**
   * Is this adapter usable? Checked by the gate before any invoice is created,
   * so a missing API key produces a refusal an operator can read rather than a
   * runtime throw a customer sees.
   */
  isConfigured(): boolean

  createPayment(input: {
    /** Ours, for correlation. Providers echo this back on their events. */
    intentId: string
    orderId: string
    amount: FiatAmount
  }): Promise<CreatedPayment>

  /**
   * Authoritative status, fetched from the provider.
   *
   * The RECONCILIATION path, and the answer to "what if the webhook never
   * arrives". Webhooks are best-effort on every provider; a system that only
   * learns about payments through them will eventually strand a customer who
   * paid. Polling this for live intents is how that gets caught.
   */
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus>

  /**
   * Verifies and normalises an inbound webhook. Does NOT apply it — applying is
   * `lib/payments/webhooks.ts`, inside a transaction, once.
   */
  handleWebhook(request: {
    rawBody: string
    headers: Headers
  }): Promise<WebhookResult>

  /**
   * Cancels an unpaid invoice at the provider.
   *
   * Called when our own quote window closes. Idempotent by contract: expiring an
   * already-expired invoice must succeed quietly, because the expiry sweep will
   * retry and a provider outage must not leave a permanently stuck intent.
   */
  expirePayment(providerReference: string): Promise<void>

  /**
   * OWNER-ONLY AT EVERY CALL SITE (section AI). The adapter does not enforce
   * that — enforcement belongs with the session, not with the HTTP client — but
   * every path that reaches this method passes through `requireOwner()` and a
   * fresh password confirmation first.
   */
  refundPayment(input: {
    providerReference: string
    amount: FiatAmount
    reason: string
  }): Promise<{ providerRefundReference: string }>
}

/**
 * How much under the quote still counts as paid.
 *
 * NOT ZERO, AND THIS IS NOT LAXNESS. Customers paying from an exchange routinely
 * arrive a few cents short because the exchange deducts its withdrawal fee from
 * the sent amount rather than adding it. Demanding an exact match would put a
 * meaningful fraction of genuine, fully-intended payments into
 * `partially_paid` — each one a support conversation and a manual release.
 *
 * One percent, floored at 50 cents so small orders are not held hostage to
 * rounding. Anything short by more than this stays `partially_paid` and waits
 * for a human, which is the correct handling for a real underpayment.
 */
export const UNDERPAYMENT_TOLERANCE_BPS = 100
export const UNDERPAYMENT_TOLERANCE_FLOOR_CENTS = 50

export function underpaymentToleranceCents(quotedCents: number): number {
  return Math.max(
    UNDERPAYMENT_TOLERANCE_FLOOR_CENTS,
    Math.round((quotedCents * UNDERPAYMENT_TOLERANCE_BPS) / 10_000),
  )
}

/**
 * How much over the quote is accepted silently.
 *
 * Overpayment is not a windfall to be pocketed — it is a customer's money that
 * arrived in the wrong quantity. Within tolerance it is treated as `paid` and
 * the difference is dust not worth a refund transaction fee. Beyond it, the
 * intent goes to `overpaid` and a human decides, because quietly keeping a
 * material overpayment is the kind of thing that ends up in front of a
 * regulator.
 */
export function overpaymentToleranceCents(quotedCents: number): number {
  return underpaymentToleranceCents(quotedCents)
}

/**
 * How long a quote is honoured.
 *
 * Fifteen minutes is the industry norm and it is a volatility decision, not a UX
 * one: it bounds how far the exchange rate can move between quoting and
 * settlement. Longer windows are friendlier and transfer the price risk to the
 * merchant.
 */
export const QUOTE_TTL_MS = 15 * 60 * 1000

/**
 * How old a signed webhook timestamp may be before it is treated as a replay.
 *
 * Five minutes accommodates clock skew and provider retry backoff without
 * leaving a captured request usable indefinitely. This is the FIRST line against
 * replay; the second, and the one that actually guarantees correctness, is the
 * unique index on `(provider, provider_event_id)`.
 */
export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000
