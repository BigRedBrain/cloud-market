/**
 * Phase 5 unit suite — access model, invites, routing, payments.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-phase-5-units.ts
 *
 * NO DATABASE, NO SERVER, NO NETWORK. Everything asserted here is a pure
 * function, which is why these modules were written as pure functions in the
 * first place. The parts that genuinely need a database — the single-slot
 * invariant, atomic invite redemption, webhook idempotency — are proved
 * separately in `verify-phase-5-db.ts`, because a race cannot be demonstrated
 * without something to race against.
 *
 * WHAT THIS SUITE IS FOR: the properties that must hold before any of that
 * matters. If the invite alphabet is biased, if the route allowlist admits a
 * product page, or if the redirect validator accepts a protocol-relative URL,
 * no amount of correct database behaviour saves the design.
 */
/** MUST BE FIRST — see the header of that module. */
import './_phase-5-test-env.mts'

import { createHmac, randomUUID } from 'node:crypto'

import {
  INVITE_CODE_ENTROPY_BITS,
  generateInviteCode,
  hashInviteCode,
  looksLikeInviteCode,
  maskInviteCode,
  normaliseInviteCode,
} from '../lib/invites/codes'
import { inviteStatus, isRedeemable } from '../lib/invites/status'
import {
  AUTH_ENTRY_PAGES,
  isPublicApi,
  isPublicPage,
  isPublicRoute,
  isSafeReturnPath,
} from '../lib/auth/public-routes'
import { safeRedirectPath } from '../lib/auth/validation'
import {
  QUOTE_TTL_MS,
  WEBHOOK_MAX_AGE_MS,
  overpaymentToleranceCents,
  underpaymentToleranceCents,
} from '../lib/payments/provider'
import { centsToCryptoAmount, signMockWebhook } from '../lib/payments/providers/mock'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    failures.push(detail ? `${name} — ${detail}` : name)
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/* ========================================================================== */
section('A. Invite code entropy and format')
/* ========================================================================== */

/**
 * The brief asked for at least 128 bits AND illustrated a five-group format
 * that can only carry about 100. The entropy figure is the security floor, so
 * it won. This assertion is what stops a later "tidy-up" shortening the code
 * back to the illustration and quietly dropping 40 bits.
 */
check(
  'code carries at least 128 bits of entropy',
  INVITE_CODE_ENTROPY_BITS >= 128,
  `got ${INVITE_CODE_ENTROPY_BITS}`,
)

const sample = generateInviteCode()

check('generated code matches CM-XXXX×7', /^CM(-[0-9A-HJKMNP-TV-Z]{4}){7}$/.test(sample.code), sample.code)
check('generated code passes its own shape check', looksLikeInviteCode(sample.code))
check('prefix is CM plus one group', /^CM-[0-9A-HJKMNP-TV-Z]{4}$/.test(sample.codePrefix), sample.codePrefix)

/**
 * The mask must not leak more than the prefix. A regression that widened the
 * displayed portion would halve the remaining search space, silently.
 */
const masked = maskInviteCode(sample.codePrefix)
check('mask reveals only the prefix', masked.startsWith(sample.codePrefix))
check('mask hides six groups', (masked.match(/••••/g) ?? []).length === 6, masked)
check(
  'mask cannot be mistaken for a usable code',
  !looksLikeInviteCode(masked),
)

/**
 * Uniformity. 32 symbols drawn from `bytes & 31` is exactly uniform, but the
 * assertion is here because the same code written against a 30-character
 * alphabet would be biased and would still look fine.
 */
{
  const counts = new Map<string, number>()
  for (let i = 0; i < 4000; i += 1) {
    for (const character of normaliseInviteCode(generateInviteCode().code)) {
      counts.set(character, (counts.get(character) ?? 0) + 1)
    }
  }
  const observed = [...counts.values()]
  const expected = (4000 * 28) / 32
  const worst = Math.max(...observed.map((n) => Math.abs(n - expected) / expected))

  check('alphabet uses all 32 symbols', counts.size === 32, `saw ${counts.size}`)
  check(
    'symbol distribution is within 15% of uniform',
    worst < 0.15,
    `worst deviation ${(worst * 100).toFixed(1)}%`,
  )
}

/** Codes must not repeat. 140 bits makes a collision here effectively impossible. */
{
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i += 1) seen.add(generateInviteCode().code)
  check('2000 generated codes are all distinct', seen.size === 2000)
}

/* ========================================================================== */
section('B. Invite normalisation — the transcription cases')
/* ========================================================================== */

const canonical = normaliseInviteCode(sample.code)

check('lower case normalises', normaliseInviteCode(sample.code.toLowerCase()) === canonical)
check('hyphens are optional', normaliseInviteCode(sample.code.replaceAll('-', '')) === canonical)
check(
  'pasted whitespace is tolerated',
  normaliseInviteCode(`  ${sample.code.replaceAll('-', ' ')}  `) === canonical,
)
check('CM prefix is optional', normaliseInviteCode(canonical) === canonical)

/**
 * Crockford's decode table is the reason the alphabet was chosen. A customer who
 * types the letter O for a zero, or I/L for a one, must succeed — those are the
 * transcription errors that actually happen, and an alphabet that merely
 * excluded the ambiguous characters would have no answer for them.
 */
check('O decodes to 0', normaliseInviteCode('CM-O123-4567-89AB-CDEF-GHJK-MNPQ-RSTV') === normaliseInviteCode('CM-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV'))
check('I decodes to 1', normaliseInviteCode('CM-I234-5678-9ABC-DEFG-HJKM-NPQR-STVW') === normaliseInviteCode('CM-1234-5678-9ABC-DEFG-HJKM-NPQR-STVW'))
check('L decodes to 1', normaliseInviteCode('CM-L234-5678-9ABC-DEFG-HJKM-NPQR-STVW') === normaliseInviteCode('CM-1234-5678-9ABC-DEFG-HJKM-NPQR-STVW'))

check('a short code is rejected by shape', !looksLikeInviteCode('CM-ABCD'))
check('an empty string is rejected by shape', !looksLikeInviteCode(''))
check('U is not in the alphabet', !looksLikeInviteCode('CM-UUUU-UUUU-UUUU-UUUU-UUUU-UUUU-UUUU'))

/* ========================================================================== */
section('C. Invite hashing — the raw code is never recoverable')
/* ========================================================================== */

/** The pepper is supplied by `_phase-5-test-env.mts`, imported first. */

{
  const hash = hashInviteCode(sample.code)

  check('digest is 64 hex characters', /^[0-9a-f]{64}$/.test(hash))
  check('digest is stable', hashInviteCode(sample.code) === hash)
  check(
    'digest is invariant under normalisation',
    hashInviteCode(sample.code.toLowerCase().replaceAll('-', ' ')) === hash,
  )
  check('a different code yields a different digest', hashInviteCode(generateInviteCode().code) !== hash)

  /**
   * The whole point of the pepper: the digest is not a bare SHA-256, so a
   * dump of `invite_codes` cannot be verified against candidate codes without
   * a secret that never went near the database.
   */
  const bare = createHmac('sha256', '').update(canonical).digest('hex')
  check('digest is not an unkeyed hash', hash !== bare)

  /** No part of the raw code may appear in what is stored. */
  check(
    'digest does not contain the code',
    !hash.includes(canonical.slice(0, 8).toLowerCase()),
  )
}

/* ========================================================================== */
section('D. Invite status derivation')
/* ========================================================================== */

const base = { deactivatedAt: null, expiresAt: null, useCount: 0, maxUses: 1 }
const now = new Date('2026-06-01T12:00:00Z')
const past = new Date('2026-05-01T12:00:00Z')
const future = new Date('2026-07-01T12:00:00Z')

check('fresh invite is active', inviteStatus(base, now) === 'active')
check('used-up invite is exhausted', inviteStatus({ ...base, useCount: 1 }, now) === 'exhausted')
check('past expiry is expired', inviteStatus({ ...base, expiresAt: past }, now) === 'expired')
check('future expiry stays active', inviteStatus({ ...base, expiresAt: future }, now) === 'active')
check('deactivated invite is deactivated', inviteStatus({ ...base, deactivatedAt: past }, now) === 'deactivated')

/**
 * Precedence. An invite that is both switched off AND expired must read
 * DEACTIVATED, because that is the fact answering "why did this stop working".
 */
check(
  'deactivation outranks expiry',
  inviteStatus({ ...base, deactivatedAt: past, expiresAt: past }, now) === 'deactivated',
)
check(
  'expiry outranks exhaustion',
  inviteStatus({ ...base, expiresAt: past, useCount: 1 }, now) === 'expired',
)

check('only active invites are redeemable', isRedeemable(base, now))
check('exhausted invites are not redeemable', !isRedeemable({ ...base, useCount: 1 }, now))

/** Multi-use budget arithmetic. */
check('partially used multi-use invite is active', inviteStatus({ ...base, maxUses: 5, useCount: 4 }, now) === 'active')
check('fully used multi-use invite is exhausted', inviteStatus({ ...base, maxUses: 5, useCount: 5 }, now) === 'exhausted')

/* ========================================================================== */
section('E. Public route allowlist — default deny')
/* ========================================================================== */

/** These four, and only these four, are reachable without a session. */
for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/forgot-password/sent']) {
  check(`${path} is public`, isPublicPage(path))
}

check('/reset-password/<token> is public', isPublicPage('/reset-password/abc123'))
check('/verify-email/<token> is public', isPublicPage('/verify-email/abc123'))

/**
 * THE CORE ASSERTION OF THE LOGIN WALL. Every storefront surface, including the
 * home page, must be private. A regression that made any of these public would
 * expose a private cannabis storefront to the open internet.
 */
for (const path of [
  '/',
  '/shop',
  '/shop/flower',
  '/product/midnight-runtz',
  '/bag',
  '/checkout',
  '/checkout/review',
  '/orders/CM-1001',
  '/account',
  '/account/security',
  '/admin',
  '/admin/products',
  '/admin/invites',
  '/admin/security/admin-access',
  '/design',
]) {
  check(`${path} is NOT public`, !isPublicRoute(path), 'login wall breach')
}

/** Prefix matching must not be defeated by a lookalike path. */
check('/sign-in-please is not public', !isPublicPage('/sign-in-please'))
check('/reset-password (no token) is not public', !isPublicPage('/reset-password'))
check('/admin/sign-in is not public', !isPublicPage('/admin/sign-in'))

/** Infrastructure endpoints that authenticate by other means. */
check('/api/health is proxy-open', isPublicApi('/api/health'))
check('/api/health/internal is proxy-open', isPublicApi('/api/health/internal'))
check('/api/cron/sweep-drafts is proxy-open', isPublicApi('/api/cron/sweep-drafts'))
check('/api/payments/webhook/mock is proxy-open', isPublicApi('/api/payments/webhook/mock'))
check('/api/admin/media/upload is NOT proxy-open', !isPublicApi('/api/admin/media/upload'))

check('sign-in and sign-up are the auth entry pages', AUTH_ENTRY_PAGES.length === 2)

/* ========================================================================== */
section('F. Return-to destinations — open redirect defence')
/* ========================================================================== */

/**
 * An open redirect on a login page is a phishing primitive: a link to OUR
 * domain that lands the victim on somebody else's credential form. Both
 * validators are asserted against the same hostile table — they are separate
 * implementations (one returns Next's typed `Route`, one must stay
 * import-free for the proxy runtime) and this is what keeps them agreeing.
 */
const HOSTILE = [
  'https://evil.test/x',
  'http://evil.test',
  '//evil.test/x',
  '///evil.test',
  '/\\evil.test',
  '\\\\evil.test',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '',
]

for (const candidate of HOSTILE) {
  check(`rejects ${JSON.stringify(candidate)}`, !isSafeReturnPath(candidate))
  check(
    `safeRedirectPath neutralises ${JSON.stringify(candidate)}`,
    safeRedirectPath(candidate) === '/account',
  )
}

const SAFE = ['/shop', '/product/midnight-runtz', '/account/security', '/bag']
for (const candidate of SAFE) {
  check(`accepts ${candidate}`, isSafeReturnPath(candidate))
  check(`safeRedirectPath preserves ${candidate}`, safeRedirectPath(candidate) === candidate)
}

check('undefined falls back', safeRedirectPath(undefined) === '/account')

/* ========================================================================== */
section('G. Crypto feature flag — disabled by default, fails closed')
/* ========================================================================== */

/**
 * Loaded lazily and re-imported per case because the gate reads `process.env`
 * at call time by design, so a deployment that flips the switch takes effect on
 * the next request rather than the next cold start.
 */
const { cryptoPaymentsEnabled, cryptoPaymentsGate, configuredProvider } = await import(
  '../lib/payments/gate'
)

const originalFlag = process.env.CRYPTO_PAYMENTS_ENABLED
const originalProvider = process.env.CRYPTO_PAYMENT_PROVIDER

delete process.env.CRYPTO_PAYMENTS_ENABLED
check('absent flag means disabled', !cryptoPaymentsEnabled())

/**
 * The permissive-parser trap. `CRYPTO_PAYMENTS_ENABLED=false` must not enable
 * crypto payments — which is exactly what `z.coerce.boolean()` would have done,
 * and the reason the variable is typed as a string.
 */
for (const value of ['false', 'FALSE', '0', 'no', 'TRUE', '1', 'yes', '']) {
  process.env.CRYPTO_PAYMENTS_ENABLED = value
  check(`"${value}" does not enable crypto`, !cryptoPaymentsEnabled())
}

process.env.CRYPTO_PAYMENTS_ENABLED = 'true'
check('only the literal "true" enables crypto', cryptoPaymentsEnabled())

/** Missing configuration fails closed even with the flag on. */
delete process.env.CRYPTO_PAYMENT_PROVIDER
{
  const gate = cryptoPaymentsGate(() => true)
  check('no provider closes the gate', !gate.open && gate.reason === 'no_provider')
}

process.env.CRYPTO_PAYMENT_PROVIDER = 'mock'
{
  const gate = cryptoPaymentsGate(() => false)
  check(
    'unconfigured provider closes the gate',
    !gate.open && gate.reason === 'provider_unconfigured',
  )

  const open = cryptoPaymentsGate(() => true)
  check('configured provider opens the gate', open.open && open.provider === 'mock')
}

/** An unrecognised provider name must not silently select anything. */
process.env.CRYPTO_PAYMENT_PROVIDER = 'not-a-provider'
check('unknown provider resolves to null', configuredProvider() === null)

process.env.CRYPTO_PAYMENTS_ENABLED = originalFlag
process.env.CRYPTO_PAYMENT_PROVIDER = originalProvider

/* ========================================================================== */
section('H. Webhook signature verification and replay')
/* ========================================================================== */

/** The webhook secret is supplied by `_phase-5-test-env.mts`, imported first. */
const { mockPaymentProvider } = await import('../lib/payments/providers/mock')

function webhookRequest(body: string, timestamp: number, signature?: string) {
  return {
    rawBody: body,
    headers: new Headers({
      'x-mock-signature': signature ?? signMockWebhook(body, timestamp),
      'x-mock-timestamp': String(timestamp),
    }),
  }
}

const validBody = JSON.stringify({
  eventId: randomUUID(),
  eventType: 'payment.confirmed',
  providerReference: 'mock_ref_1',
  status: 'paid',
  amountCents: 5000,
})

{
  const result = await mockPaymentProvider.handleWebhook(webhookRequest(validBody, Date.now()))
  check('a correctly signed webhook verifies', result.ok)
}

{
  const result = await mockPaymentProvider.handleWebhook(
    webhookRequest(validBody, Date.now(), 'de'.repeat(32)),
  )
  check(
    'a forged signature is rejected',
    !result.ok && result.reason === 'bad_signature',
  )
}

{
  /** Signed correctly, but the body was altered afterwards. */
  const tampered = validBody.replace('5000', '1')
  const timestamp = Date.now()
  const result = await mockPaymentProvider.handleWebhook({
    rawBody: tampered,
    headers: new Headers({
      'x-mock-signature': signMockWebhook(validBody, timestamp),
      'x-mock-timestamp': String(timestamp),
    }),
  })
  check('a tampered body is rejected', !result.ok && result.reason === 'bad_signature')
}

{
  /** A captured request replayed later. Signature is genuine; the clock is not. */
  const stale = Date.now() - WEBHOOK_MAX_AGE_MS - 60_000
  const result = await mockPaymentProvider.handleWebhook(webhookRequest(validBody, stale))
  check('a stale timestamp is rejected', !result.ok && result.reason === 'stale_timestamp')
}

{
  const result = await mockPaymentProvider.handleWebhook({
    rawBody: validBody,
    headers: new Headers(),
  })
  check('a missing signature is rejected', !result.ok && result.reason === 'malformed')
}

{
  const timestamp = Date.now()
  const result = await mockPaymentProvider.handleWebhook(
    webhookRequest('not json at all', timestamp),
  )
  check('a malformed body is rejected', !result.ok && result.reason === 'malformed')
}

/* ========================================================================== */
section('I. Payment amount arithmetic')
/* ========================================================================== */

/**
 * Tolerance exists because exchanges deduct withdrawal fees from the sent
 * amount. Demanding an exact match would route a meaningful fraction of
 * genuine payments to manual review.
 */
check('1% tolerance on $100', underpaymentToleranceCents(10_000) === 100)
check('floor applies to small orders', underpaymentToleranceCents(1000) === 50)
check('tolerance is symmetric', overpaymentToleranceCents(10_000) === underpaymentToleranceCents(10_000))
check('quote TTL is 15 minutes', QUOTE_TTL_MS === 15 * 60 * 1000)

/**
 * Crypto amounts are computed with BigInt and returned as decimal strings.
 * A float would reintroduce exactly the rounding error `lib/money.ts` exists to
 * prevent, on values where the error is somebody's money.
 */
check('$100,000 at $100,000/BTC is 1.0 BTC', centsToCryptoAmount(100_000_00, 100_000_00) === '1.000000000000000000')
check('$50,000 at $100,000/BTC is 0.5 BTC', centsToCryptoAmount(50_000_00, 100_000_00) === '0.500000000000000000')
check('result always has 18 decimal places', centsToCryptoAmount(1, 100_000_00).split('.')[1].length === 18)
check('result is never in exponent notation', !centsToCryptoAmount(1, 100_000_00).includes('e'))

/* ========================================================================== */

console.log(
  `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m (${passed + failed} checks)\n`,
)

if (failed > 0) {
  for (const failure of failures) console.error(`  \x1b[31m✗\x1b[0m ${failure}`)
  process.exit(1)
}
