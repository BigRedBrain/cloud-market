import { handleInboundWebhook } from '@/lib/payments/webhooks'
import { cryptoPaymentsEnabled } from '@/lib/payments/gate'
import type { PaymentProvider } from '@/lib/db/schema'

/**
 * Provider webhook endpoint — `POST /api/payments/webhook/[provider]`.
 *
 * THIS IS THE ONLY WAY A PAYMENT BECOMES CONFIRMED. Nothing a browser sends can
 * move an intent to `paid`: not a query parameter, not a callback URL, not
 * localStorage, not a transaction hash the customer pasted, not a screenshot.
 * Confirmation arrives here, over a signed channel, from the provider, and is
 * verified before it is stored (section AE).
 *
 * AUTHENTICATION IS THE SIGNATURE, NOT A SESSION. A provider has no cookie and
 * never will. The credential is an HMAC over the raw body, checked by the
 * adapter in constant time, and the request is rejected before parsing if it
 * does not verify.
 *
 * WHY THIS ROUTE IS NOT IN THE PUBLIC ALLOWLIST. It does not need to be: it is
 * under `/api/`, and the proxy's rule for API routes is to 401 anything without
 * a session cookie — which would block every provider. So it is listed in
 * `PUBLIC_API_PREFIXES` as `/api/payments/webhook/`, meaning "the proxy does not
 * gate this", exactly as `/api/cron/` is. The route authenticates itself, more
 * strongly than a cookie would.
 */

/** A signature is computed over bytes. Caching them would be nonsense. */
export const dynamic = 'force-dynamic'

const KNOWN_PROVIDERS = new Set<string>(['mock', 'btcpay', 'coinbase_commerce'])

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  /**
   * The kill switch applies to inbound events too.
   *
   * With crypto disabled there is nothing legitimate to receive, so the endpoint
   * refuses everything rather than accepting and storing events for a feature
   * that is off. This is what keeps the attack surface of an unreleased feature
   * at zero for the whole of this phase.
   */
  if (!cryptoPaymentsEnabled()) {
    return new Response(null, { status: 404 })
  }

  const { provider } = await context.params

  /**
   * An unknown provider gets a 404 and no explanation. Echoing the value back
   * would make this a reflection point, and confirming which providers ARE
   * recognised tells an attacker which signature scheme to go and study.
   */
  if (!KNOWN_PROVIDERS.has(provider)) {
    return new Response(null, { status: 404 })
  }

  /**
   * THE RAW BODY, READ EXACTLY ONCE AND NEVER RE-SERIALISED.
   *
   * Every provider signs the bytes it sent. `await request.json()` followed by
   * `JSON.stringify` produces different bytes — key order, whitespace, unicode
   * escaping — and the signature will not verify, or worse, will verify against
   * something other than what was signed. The adapter parses the string itself,
   * after checking the MAC over it.
   */
  const rawBody = await request.text()

  const outcome = await handleInboundWebhook(
    provider as PaymentProvider,
    rawBody,
    request.headers,
  )

  if (!outcome.handled) {
    /**
     * 400 FOR EVERY REJECTION, WITH NO DETAIL AND NO DISTINCTION.
     *
     * A bad signature, a stale timestamp, a malformed body and an unknown
     * reference all return the same empty 400. Distinguishing them would make
     * this endpoint an oracle: a caller could learn that a reference exists by
     * seeing "bad signature" instead of "unknown reference", and could tune a
     * forgery attempt by watching which failure mode it hit. The real reason is
     * recorded in `payment_events` and audited.
     *
     * 400 rather than 401 because providers treat 4xx as "do not retry", which
     * is correct for all four: none of them will succeed on a second attempt.
     */
    return new Response(null, { status: 400 })
  }

  /**
   * 200 FOR BOTH A FRESH EVENT AND A DUPLICATE.
   *
   * A provider that receives a non-2xx retries with backoff. Answering a
   * duplicate with an error would put it in a retry loop over an event we have
   * already applied — so "yes, I have this" is both the honest answer and the
   * one that makes the retry stop.
   */
  return Response.json(
    { received: true, duplicate: outcome.duplicate },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
