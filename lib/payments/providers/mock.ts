import 'server-only'

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type {
  CreatedPayment,
  FiatAmount,
  PaymentProviderAdapter,
  ProviderPaymentStatus,
  VerifiedWebhook,
  WebhookResult,
} from '../provider'
import { QUOTE_TTL_MS, WEBHOOK_MAX_AGE_MS } from '../provider'

/**
 * The mock payment provider.
 *
 * NOT A STUB TO BE DELETED. This is a permanent fixture, and it is how every
 * edge case in section AG gets tested: underpayment, overpayment, wrong network,
 * wrong currency, expiry, late payment, duplicate transaction, duplicate
 * webhook, replay. Reproducing those against a real provider would need a
 * testnet, a faucet, and the patience to wait for confirmations — which in
 * practice means they would be tested once by hand and never again in CI.
 *
 * IT IMPLEMENTS REAL SIGNATURE VERIFICATION, deliberately. A mock that accepted
 * any webhook would make "invalid signature rejected" untestable, and that is
 * one of the assertions that matters most. The scheme below — HMAC-SHA256 over
 * `timestamp.rawBody`, compared in constant time — is the same shape Stripe,
 * BTCPay and Coinbase Commerce all use, so the test suite exercises the actual
 * verification logic rather than a placeholder that will be replaced by
 * something with different failure modes.
 *
 * IT CANNOT REACH PRODUCTION. `configuredProvider()` in `../gate.ts` refuses to
 * return `mock` when `NODE_ENV === 'production'`, so a typo in the provider
 * variable cannot silently select the adapter that marks invoices paid on
 * request.
 */

const SIGNATURE_HEADER = 'x-mock-signature'
const TIMESTAMP_HEADER = 'x-mock-timestamp'

/** Deterministic fake rate: 1 BTC = $100,000. Keeps test arithmetic legible. */
const MOCK_RATE_CENTS_PER_UNIT = 100_000_00

function secret(): string | undefined {
  return process.env.MOCK_PAYMENT_WEBHOOK_SECRET
}

/**
 * Converts integer cents to a decimal string with 18 places.
 *
 * STRING ARITHMETIC VIA BIGINT, never floating point. `cents / rate` in
 * JavaScript is a float, and a float that represents money is a bug waiting for
 * a large enough number. Scaling into BigInt first keeps every digit exact.
 */
export function centsToCryptoAmount(cents: number, centsPerUnit: number): string {
  const scaled = (BigInt(cents) * 10n ** 18n) / BigInt(centsPerUnit)
  const whole = scaled / 10n ** 18n
  const fraction = (scaled % 10n ** 18n).toString().padStart(18, '0')
  return `${whole}.${fraction}`
}

/** The signature a caller must present. Exported so tests can sign correctly. */
export function signMockWebhook(rawBody: string, timestamp: number): string {
  const key = secret()
  if (!key) throw new Error('MOCK_PAYMENT_WEBHOOK_SECRET is not set')
  return createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex')
}

type MockWebhookPayload = {
  eventId: string
  eventType: string
  providerReference: string
  status: ProviderPaymentStatus['status']
  amountReceived?: string | null
  failureCode?: string | null
}

export const mockPaymentProvider: PaymentProviderAdapter = {
  id: 'mock',

  isConfigured() {
    return Boolean(secret())
  },

  async createPayment(input: {
    intentId: string
    orderId: string
    amount: FiatAmount
  }): Promise<CreatedPayment> {
    return {
      /**
       * Includes our intent id so a test reading provider state can correlate
       * without a lookup table. A real provider would return its own opaque id.
       */
      providerReference: `mock_${input.intentId}`,
      paymentAddress: `bcrt1qmock${input.intentId.replace(/-/g, '').slice(0, 20)}`,
      cryptoCurrency: 'BTC',
      cryptoNetwork: 'regtest',
      cryptoAmount: centsToCryptoAmount(input.amount.cents, MOCK_RATE_CENTS_PER_UNIT),
      exchangeRate: `${MOCK_RATE_CENTS_PER_UNIT / 100}.000000000000000000`,
      quoteExpiresAt: new Date(Date.now() + QUOTE_TTL_MS),
    }
  },

  /**
   * Always reports `awaiting_payment`.
   *
   * The mock holds NO STATE ON PURPOSE. State would have to live somewhere —
   * a module-scope map, which does not survive a serverless invocation, or a
   * table, which would mean the fake provider needed migrations. Tests drive
   * outcomes by POSTing signed webhooks, which is both simpler and a more
   * faithful reproduction of how a real provider actually tells us things.
   */
  async getPaymentStatus(): Promise<ProviderPaymentStatus> {
    return { status: 'awaiting_payment', amountReceived: null }
  },

  async handleWebhook(request: {
    rawBody: string
    headers: Headers
  }): Promise<WebhookResult> {
    if (!secret()) return { ok: false, reason: 'not_configured' }

    const presented = request.headers.get(SIGNATURE_HEADER)
    const timestampRaw = request.headers.get(TIMESTAMP_HEADER)

    if (!presented || !timestampRaw) return { ok: false, reason: 'malformed' }

    const timestamp = Number(timestampRaw)
    if (!Number.isFinite(timestamp)) return { ok: false, reason: 'malformed' }

    /**
     * TIMESTAMP FIRST, SIGNATURE SECOND.
     *
     * Checking the age before the HMAC means a flood of stale replays is
     * rejected without spending a hash each. The order does not weaken anything:
     * the timestamp is INSIDE the signed payload, so an attacker cannot move it
     * without invalidating the signature they have not yet been asked for.
     */
    if (Math.abs(Date.now() - timestamp) > WEBHOOK_MAX_AGE_MS) {
      return { ok: false, reason: 'stale_timestamp' }
    }

    /**
     * Constant-time comparison. `===` on a MAC leaks it one byte at a time
     * through response timing — the classic signature-verification mistake, and
     * the reason this mock does it properly rather than approximately.
     */
    const expected = signMockWebhook(request.rawBody, timestamp)
    const a = Buffer.from(presented, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad_signature' }
    }

    let payload: MockWebhookPayload
    try {
      payload = JSON.parse(request.rawBody) as MockWebhookPayload
    } catch {
      return { ok: false, reason: 'malformed' }
    }

    if (
      typeof payload.eventId !== 'string' ||
      typeof payload.providerReference !== 'string' ||
      typeof payload.status !== 'string'
    ) {
      return { ok: false, reason: 'malformed' }
    }

    const event: VerifiedWebhook = {
      providerEventId: payload.eventId,
      eventType: payload.eventType ?? 'payment.updated',
      providerReference: payload.providerReference,
      providerTimestamp: new Date(timestamp),
      status: {
        status: payload.status,
        amountReceived: payload.amountReceived ?? null,
        failureCode: payload.failureCode ?? null,
      },
      payload,
    }

    return { ok: true, event }
  },

  async expirePayment(): Promise<void> {
    /** Stateless: nothing to cancel. Succeeds quietly, as the contract requires. */
  },

  async refundPayment(): Promise<{ providerRefundReference: string }> {
    return { providerRefundReference: `mock_refund_${randomUUID()}` }
  },
}
