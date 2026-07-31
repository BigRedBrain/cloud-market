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

  return NextResponse.next()
}

export const config = {
  /**
   * Skip static assets, image optimisation, and metadata files. Running on
   * those is pure overhead — and because prefetches hit this too, the matcher
   * is the main lever on how often it executes.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
