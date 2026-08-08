/**
 * The public route allowlist.
 *
 * CloudMarket is a PRIVATE, INVITE-ONLY storefront. Everything is behind
 * authentication except the handful of pages a person must be able to reach in
 * order to authenticate at all.
 *
 * AN ALLOWLIST, NOT A BLOCKLIST, AND THAT IS THE WHOLE POINT. The previous shape
 * of `proxy.ts` listed the PROTECTED prefixes — `/account` and `/admin` — and
 * let everything else through. Under that design every new route is public by
 * default, and privacy depends on whoever adds `/wishlist` next year
 * remembering to extend a list in a different file. Here the default is denial:
 * a new route is private until somebody deliberately writes it down below, and
 * forgetting produces a locked door rather than an open one.
 *
 * NO IMPORTS, DELIBERATELY. This module is read by `proxy.ts`, which runs in a
 * constrained runtime with no database access, and by the Data Access Layer,
 * which runs on the server. Both must agree exactly on what "public" means, and
 * the only way to guarantee that is for both to read the same list.
 *
 * THIS FILE IS NOT THE SECURITY BOUNDARY. The proxy that consumes it is
 * optimistic UX — it checks whether a session cookie is PRESENT, never whether
 * it is valid. Authorization happens server-side in the DAL, next to the data.
 * See the header of `proxy.ts`.
 */

/**
 * Pages reachable with no session at all.
 *
 * Every entry is here because authentication is impossible without it:
 *
 *  - `/sign-in`         — the front door.
 *  - `/sign-up`         — invite-gated, but the FORM must render for someone
 *                         holding an invite to use it. The invite is checked
 *                         server-side on submit, not by hiding the page.
 *  - `/forgot-password` — reached by someone who by definition cannot sign in.
 *  - `/forgot-password/sent` — its confirmation screen.
 *
 * Note what is NOT here: `/`, `/shop`, `/product/*`, `/bag`, `/checkout`,
 * `/orders/*`, `/account/*`, `/admin/*` and `/design`. All of them require a
 * session, including the home page.
 */
export const PUBLIC_EXACT_PATHS = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/forgot-password/sent',
] as const

/**
 * Prefixes whose paths carry a one-time token in the URL.
 *
 * These cannot require a session: the entire purpose of a password-reset link is
 * to be usable by someone locked out, and an email-verification link is
 * routinely opened in a different browser from the one that signed up.
 *
 * The token IS the credential. It is 256 bits from the CSPRNG, stored only as a
 * SHA-256 digest, single-use, and short-lived — see `lib/auth/tokens.ts`. These
 * routes are "public" only in the sense that they authenticate with something
 * other than a cookie.
 */
export const PUBLIC_PREFIXES = ['/reset-password/', '/verify-email/'] as const

/**
 * Infrastructure endpoints that must answer without a session.
 *
 *  - `/api/health` — the deployment platform's liveness probe runs before any
 *    session exists and would fail every deploy otherwise. It is reduced to a
 *    bare liveness answer for exactly this reason (section AL); the detailed
 *    diagnostic version is authenticated and lives at `/api/health/internal`.
 *
 *  - `/api/cron/` — invoked by the scheduler, authenticated by `CRON_SECRET`
 *    rather than by a cookie. It is not unauthenticated, it is authenticated
 *    differently, and it returns 503 when the secret is unset rather than
 *    running open.
 */
export const PUBLIC_API_EXACT = [
  '/api/health',
  /**
   * "Public" HERE MEANS "THE PROXY DOES NOT GATE IT", NOT "UNAUTHENTICATED".
   *
   * The internal probe authenticates itself, and accepts either an
   * administrator's session or `Authorization: Bearer <CRON_SECRET>`. The bearer
   * path is the reason it is listed: a monitoring system has no session cookie,
   * so a proxy-level cookie check would 401 it before its own — stronger —
   * authentication ever ran. The handler returns a bare 401 to everyone else.
   */
  '/api/health/internal',
] as const

export const PUBLIC_API_PREFIXES = [
  '/api/cron/',
  /**
   * Payment provider webhooks. Again "public" means only that the PROXY does
   * not gate them — a payment provider has no session cookie, so a cookie check
   * here would reject every legitimate event before its real authentication
   * ran. The handler verifies an HMAC over the raw request body in constant
   * time and rejects anything that does not match, which is a stronger
   * credential than a cookie, not a weaker one.
   *
   * The route additionally returns 404 for everything while
   * `CRYPTO_PAYMENTS_ENABLED` is false, so this surface is inert for the whole
   * of this phase.
   */
  '/api/payments/webhook/',
] as const

/**
 * Well-known files served at the root that must resolve before authentication.
 * `robots.txt` in particular has to be readable by a crawler in order to tell
 * that crawler to go away.
 */
export const PUBLIC_WELL_KNOWN = [
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
  '/manifest.webmanifest',
] as const

/** Is this a browser page that anonymous visitors may load? */
export function isPublicPage(pathname: string): boolean {
  if ((PUBLIC_EXACT_PATHS as readonly string[]).includes(pathname)) return true
  if ((PUBLIC_WELL_KNOWN as readonly string[]).includes(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** Is this an endpoint that answers without a session? */
export function isPublicApi(pathname: string): boolean {
  if ((PUBLIC_API_EXACT as readonly string[]).includes(pathname)) return true
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** Anything reachable anonymously, page or endpoint. */
export function isPublicRoute(pathname: string): boolean {
  return isPublicPage(pathname) || isPublicApi(pathname)
}

/**
 * Pages an already-authenticated visitor should be bounced away from. Landing
 * on a sign-in form while holding a live session is a dead end.
 */
export const AUTH_ENTRY_PAGES = ['/sign-in', '/sign-up'] as const

/**
 * Constrains a post-sign-in destination to a path on this origin.
 *
 * DUPLICATED FROM `safeRedirectPath` IN `validation.ts`, ON PURPOSE. That one
 * returns Next's typed `Route`, which drags in type-level machinery this module
 * must not have if it is to stay importable by the proxy runtime. The two
 * implement identical rules and the test suite asserts they agree on a shared
 * table of hostile inputs, which is a cheaper guarantee than making one of them
 * import the other.
 *
 * An unchecked `?next=` is an open redirect, and an open redirect on a login
 * page is a phishing primitive: a link to OUR domain that lands the victim on
 * somebody else's credential form. Rejected here:
 *
 *   `https://evil.test/x`  — absolute, has a scheme
 *   `//evil.test/x`        — protocol-relative; the browser treats it as a host
 *   `/\evil.test`          — backslash, which some parsers normalise to `/`
 *   `javascript:alert(1)`  — scheme with no leading slash
 *
 * Accepted: paths beginning with a single `/` and containing no backslash.
 */
export function isSafeReturnPath(candidate: string | null | undefined): boolean {
  if (!candidate) return false
  if (!candidate.startsWith('/')) return false
  if (candidate.startsWith('//')) return false
  if (candidate.includes('\\')) return false
  return true
}
