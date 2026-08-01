import { NextResponse, type NextRequest } from 'next/server'

/**
 * Optimistic route protection.
 *
 * Next 16 renamed Middleware to Proxy, and its guidance is explicit that this
 * layer must NOT be the authorization solution: it runs on every request
 * including prefetches, it cannot safely touch the database, and a Server
 * Component reached by any other path would bypass it entirely.
 *
 * So this does exactly one cheap thing — checks whether a session cookie is
 * *present* — and nothing else. It never decodes, validates, or trusts it.
 * A forged cookie gets past this file and is then rejected by the Data Access
 * Layer, which is where authorization actually happens (`lib/auth/dal.ts`).
 *
 * The value here is purely user experience: an anonymous visitor clicking an
 * account link is bounced straight to sign-in instead of rendering a protected
 * page shell and redirecting a beat later.
 */

/** Must match `SESSION_COOKIE` in `lib/auth/session.ts`. */
const SESSION_COOKIE =
  process.env.NODE_ENV === 'production'
    ? '__Host-cloudmarket_session'
    : 'cloudmarket_session'

const PROTECTED_PREFIXES = ['/account', '/admin'] as const
const AUTH_PAGES = ['/sign-in', '/sign-up'] as const

/** Routes whose path carries a one-time token. See the note in `proxy` below. */
const TOKEN_BEARING_PREFIXES = ['/verify-email/', '/reset-password/'] as const

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Presence only. This is not a validity check and must never become one.
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE)

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )

  if (isProtected && !hasSessionCookie) {
    const signIn = new URL('/sign-in', request.url)
    // Preserve the destination so the deep link survives the round trip.
    signIn.searchParams.set('next', pathname)
    return NextResponse.redirect(signIn)
  }

  /**
   * Already carrying a session? Skip the sign-in form. Only "optimistically" —
   * if the cookie turns out to be stale, /account's DAL check bounces them
   * back, and the cookie is cleared on the way.
   */
  if (AUTH_PAGES.includes(pathname as (typeof AUTH_PAGES)[number]) && hasSessionCookie) {
    return NextResponse.redirect(new URL('/account', request.url))
  }

  const response = NextResponse.next()

  /**
   * Token-bearing URLs are never stored.
   *
   * `Cache-Control` for these has to be set HERE rather than in next.config's
   * `headers()`. Next owns that header for App Router routes and overwrites
   * whatever the config says — a dynamic page comes back as
   * `no-cache, must-revalidate`, which still permits a store. Setting it on the
   * response as it leaves is the only place the value survives.
   * (`Referrer-Policy` from next.config does apply; it is repeated here so both
   * headers for these routes are visible in one place.)
   *
   * Neither header makes the URL secret — browser history, proxy logs and
   * corporate TLS inspection can still record it. That is exactly why the TTL
   * is short and the token single-use: exposure is assumed, and what is being
   * controlled is how long it matters.
   */
  if (TOKEN_BEARING_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Referrer-Policy', 'no-referrer')
  }

  return response
}

export const config = {
  /**
   * Skip static assets, image optimisation, and metadata files. Running on
   * those is pure overhead — and because prefetches hit this too, the matcher
   * is the main lever on how often it executes.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
