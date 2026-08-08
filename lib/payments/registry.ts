import 'server-only'

import type { PaymentProvider } from '@/lib/db/schema'
import type { PaymentProviderAdapter } from './provider'
import { mockPaymentProvider } from './providers/mock'

/**
 * Adapter registry.
 *
 * The one place that knows which concrete adapters exist. Everything else takes
 * a `PaymentProviderAdapter` and never learns which one it has.
 *
 * ONLY `mock` IS REGISTERED. `btcpay` and `coinbase_commerce` are values in the
 * `payment_provider` enum so that adding either later is a new file rather than
 * a migration — but neither has an implementation, because choosing a processor
 * for a cannabis retailer is a compliance decision, not an engineering one.
 * `getAdapter` returns null for them, the gate refuses, and nothing pretends
 * otherwise.
 *
 * `mock` is additionally barred from production by `configuredProvider()` in
 * `./gate.ts`, so registering it here cannot make it reachable where real money
 * is.
 */
const ADAPTERS: Partial<Record<PaymentProvider, PaymentProviderAdapter>> = {
  mock: mockPaymentProvider,
}

export function getAdapter(provider: PaymentProvider): PaymentProviderAdapter | null {
  return ADAPTERS[provider] ?? null
}

/**
 * Is this provider both registered and configured?
 *
 * The predicate `cryptoPaymentsGate` takes. Kept here rather than inside the
 * gate so that the gate module stays free of adapter imports — those pull in
 * provider SDKs, and the gate is asked "is crypto on?" from places that have no
 * business loading an HTTP client.
 */
export function providerIsConfigured(provider: PaymentProvider): boolean {
  return getAdapter(provider)?.isConfigured() ?? false
}
