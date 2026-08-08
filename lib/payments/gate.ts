import 'server-only'

import type { PaymentProvider } from '@/lib/db/schema'

/**
 * The crypto-payments kill switch.
 *
 * DEFAULTS TO OFF, and stays off for this entire phase. An absent
 * `CRYPTO_PAYMENTS_ENABLED` means disabled, not enabled — the same reasoning as
 * `lib/orders/gate.ts`: a feature that turns itself on when an environment
 * variable goes missing is not a kill switch, it is a fuse that only blows the
 * wrong way. The value must be the literal string `true`; `1`, `yes` and `TRUE`
 * all read as off, because a switch in front of money should not have a
 * permissive parser.
 *
 * MISSING CONFIGURATION FAILS CLOSED, SEPARATELY FROM THE FLAG. Even with the
 * flag on, `cryptoPaymentsGate()` refuses unless a provider is selected AND that
 * provider reports itself configured. Turning the flag on against an
 * unconfigured provider must produce a refusal an operator can read, not an
 * invoice nobody can pay.
 *
 * WHAT IS BUILT AND WHAT IS NOT. The architecture in this directory is complete
 * and tested against the `mock` provider. No real provider adapter exists yet,
 * because selecting one is a business decision with compliance consequences.
 * The seam is `PaymentProviderAdapter` in `./provider.ts`; adding BTCPay or
 * Coinbase Commerce later is a new file implementing five methods, not a
 * rewrite of checkout.
 */

export type CryptoGate =
  | { open: true; provider: PaymentProvider }
  | { open: false; reason: 'disabled' }
  | { open: false; reason: 'no_provider' }
  | { open: false; reason: 'provider_unconfigured'; provider: PaymentProvider }

/**
 * Is the flag on?
 *
 * Read from `process.env` at call time rather than captured at module scope, so
 * a deployment that flips it takes effect on the next request instead of the
 * next cold start. That matters most in the direction that turns it OFF.
 */
export function cryptoPaymentsEnabled(): boolean {
  return process.env.CRYPTO_PAYMENTS_ENABLED === 'true'
}

/**
 * Which provider this deployment is configured to use.
 *
 * `mock` is accepted ONLY outside production. Without that guard, a production
 * deployment with a typo in `CRYPTO_PAYMENT_PROVIDER` could silently select the
 * fake provider — which cheerfully marks invoices paid — and start releasing
 * orders against payments that never happened. The mock exists so the edge cases
 * in section AG can be tested deterministically, and it must never be reachable
 * where real money is.
 */
export function configuredProvider(): PaymentProvider | null {
  const raw = process.env.CRYPTO_PAYMENT_PROVIDER?.trim()
  if (!raw) return null

  if (raw === 'mock') {
    return process.env.NODE_ENV === 'production' ? null : 'mock'
  }

  if (raw === 'btcpay' || raw === 'coinbase_commerce') return raw

  return null
}

/**
 * May a crypto payment be created right now?
 *
 * ORDER OF CHECKS MATTERS, and it is the same ordering `checkoutGate` uses: the
 * flag is first and cheapest, so a deployment with the feature switched off
 * reports "disabled" rather than complaining about an unconfigured provider it
 * was never going to use.
 *
 * `providerIsConfigured` is injected rather than imported so this module stays
 * free of the adapter registry — which imports provider SDKs, and would
 * otherwise be pulled into every bundle that merely wants to ask whether the
 * feature is on.
 */
export function cryptoPaymentsGate(
  providerIsConfigured: (provider: PaymentProvider) => boolean,
): CryptoGate {
  if (!cryptoPaymentsEnabled()) return { open: false, reason: 'disabled' }

  const provider = configuredProvider()
  if (!provider) return { open: false, reason: 'no_provider' }

  if (!providerIsConfigured(provider)) {
    return { open: false, reason: 'provider_unconfigured', provider }
  }

  return { open: true, provider }
}

/**
 * Customer-facing text.
 *
 * NEVER NAMES AN ENVIRONMENT VARIABLE OR A PROVIDER. All three closed states
 * collapse to the same sentence for the customer: whether crypto is switched
 * off, unconfigured, or misconfigured is an operational detail, and telling a
 * shopper which one it is tells an attacker the same thing. The distinction is
 * preserved for operators in `/api/health/internal` and in the audit log.
 */
export function describeCryptoGate(_gate: Extract<CryptoGate, { open: false }>): string {
  return 'Paying with crypto is not available right now. Please choose another payment method.'
}
