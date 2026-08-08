import { NextResponse, type NextRequest } from 'next/server'

import {
  AUTH_ENTRY_PAGES,
  isPublicApi,
  isPublicPage,
  isSafeReturnPath,
} from '@/lib/auth/public-routes'

/**
 * Optimistic route protection for a PRIVATE storefront.
 *
 * Next 16 renamed Middleware to Proxy, and its guidance is explicit that this
 * layer must NOT be the authorization solution: it runs on every request
 * including prefetches, it cannot safely touch the database, and a Server
 * Component reached by any other path would bypass it entirely.
 *
 * So this does exactly one cheap thing — checks whether a session cookie is
 * PRESENT — and nothing else. It never decodes, validates, or trusts it. A
 * forged or expired cookie sails straight past this file and is then rejected by
 * the Data Access Layer, which is where authorization actually happens
 * (`lib/auth/dal.ts`). Every protected page independently calls a DAL guard;
 * none of them relies on having been filtered here.
 *
 * WHAT CHANGED IN PHASE 5, AND WHY IT MATTERS
 *
 * This file used to list the PROTECTED prefixes (`/account`, `/admin`) and let
 * everything else through. The storefront is now private, so the polarity is
 * inverted: everything is protected unless it appears in the allowlist at
 * `lib/auth/public-routes.ts`. A route added next year is private until someone
 * deliberately makes it public — the failure mode of forgetting is a locked
 * door, not an open one.
 *
 * WHY THIS IS STILL WORTH HAVING even though it protects nothing: without it,
 * an anonymous visitor clicking a product link renders a protected page shell,
 * runs a database query, and only then redirects. With it they are bounced at
 * the edge before any of that happens. The value is latency and load, not
 * security.
 */

/** Must match `SESSION_COOKIE` in `lib/auth/session.ts`. */
const SESSION_COOKIE =
  process.env.NODE_ENV === 'production'
    ? '__Host-cloudmarket_session'
    : 'cloudmarket_session'

/** Routes whose path carries a one-time token. See the note further down. */
const TOKEN_BEARING_PREFIXES = ['/verify-email/', '/reset-password/'] as const

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Presence only. This is not a validity check and must never become one.
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE)

  /**
   * A fresh nonce per request, from the platform CSPRNG.
   *
   * It must be unpredictable and must never repeat: a nonce an attacker can
   * guess is a nonce that lets injected script execute, which is the one thing
   * the policy exists to prevent. `crypto.randomUUID()` is 122 bits of
   * randomness and is available in this runtime, where `node:crypto` is not.
   */
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  /**
   * Passed DOWN to the render as a request header, which is how Next finds it
   * and stamps it onto its own script tags. Without this the framework's
   * bootstrap scripts carry no nonce and would be blocked the moment the
   * report-only policy is promoted to enforcing.
   */
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  const forward = () => NextResponse.next({ request: { headers: requestHeaders } })

  /**
   * API routes are answered, never redirected.
   *
   * A 307 to an HTML sign-in page is a useless response to a programmatic
   * caller — it turns "you are not authenticated" into "here is some markup",
   * which a client then has to parse to discover it failed. A 401 with a JSON
   * body is the honest answer, and it is also what makes the end-to-end tests
   * able to assert on authentication rather than on page content.
   *
   * The route handlers themselves ALSO authenticate. This is the cheap early
   * exit, not the control.
   */
  if (pathname.startsWith('/api/')) {
    if (isPublicApi(pathname)) return withSecurityHeaders(forward(), pathname, nonce)

    if (!hasSessionCookie) {
      return NextResponse.json(
        { error: 'unauthenticated' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    return withSecurityHeaders(forward(), pathname, nonce)
  }

  const publicPage = isPublicPage(pathname)

  /**
   * THE LOGIN WALL. Default deny for every browser page not on the allowlist.
   */
  if (!publicPage && !hasSessionCookie) {
    const signIn = new URL('/sign-in', request.url)

    /**
     * Preserve the destination so a deep link survives the round trip.
     *
     * `pathname` only — the query string is deliberately dropped. It can carry
     * filter state that is harmless, but it can equally carry something a
     * customer would not want bounced through a redirect chain and into server
     * logs, and no sign-in flow needs it. `isSafeReturnPath` re-checks the
     * result even though we constructed it, because the value is read back out
     * of a URL later and everything read out of a URL is untrusted.
     */
    if (isSafeReturnPath(pathname) && pathname !== '/') {
      signIn.searchParams.set('next', pathname)
    }

    return withSecurityHeaders(NextResponse.redirect(signIn), pathname, nonce)
  }

  /**
   * Already carrying a session? Skip the sign-in and sign-up forms. Only
   * "optimistically" — if the cookie turns out to be stale, the DAL check on
   * /account bounces them back, clearing the cookie on the way.
   */
  if (
    AUTH_ENTRY_PAGES.includes(pathname as (typeof AUTH_ENTRY_PAGES)[number]) &&
    hasSessionCookie
  ) {
    return withSecurityHeaders(
      NextResponse.redirect(new URL('/account', request.url)),
      pathname,
      nonce,
    )
  }

  return withSecurityHeaders(forward(), pathname, nonce)
}

/**
 * Headers that have to be set HERE rather than in `next.config.ts`.
 *
 * Next owns `Cache-Control` for App Router routes and overwrites whatever the
 * config's `headers()` says — a dynamic page comes back as
 * `no-cache, must-revalidate`, which still permits a store. Setting it on the
 * response as it leaves is the only place the value survives.
 */
/**
 * Content-Security-Policy.
 *
 * DEPLOYED IN TWO PARTS, AND THE SPLIT IS THE WHOLE DESIGN.
 *
 * `next.config.ts` recorded that this project had no CSP, on purpose, because a
 * meaningful one needs a per-request nonce. This is that nonce — but a
 * nonce-based policy has a failure mode that is both severe and silent: a page
 * whose HTML was PRERENDERED AT BUILD TIME carries no nonce, so an enforcing
 * `script-src 'nonce-…' 'strict-dynamic'` blocks its bootstrap scripts and the
 * page dies with a console error most users never see. Next's own guidance says
 * as much — nonces require dynamic rendering.
 *
 * Almost every route here is already dynamic (the login wall made it so), but
 * "almost" is not a basis for shipping a policy that breaks whatever is left,
 * and a CSP cannot be validated by a type checker or a build. So:
 *
 *   ENFORCED — directives that cannot break rendering under any circumstance.
 *   `frame-ancestors`, `object-src`, `base-uri` and `form-action` restrict what
 *   the page may be embedded in, load as a plugin, rewrite its base URL to, or
 *   submit to. None of them can block a script that was going to run anyway.
 *   These are live now and are the clickjacking and form-hijacking defence
 *   (`frame-ancestors` is also the modern replacement for `X-Frame-Options`,
 *   which is retained in `next.config.ts` for older browsers).
 *
 *   REPORT-ONLY — the full nonce-based `script-src`/`style-src` policy. It is
 *   evaluated by the browser against real traffic and reported, without blocking
 *   anything. Promoting it to enforcing is a one-line change in the header name,
 *   and the runbook makes that a deliberate step taken after the violation
 *   reports come back clean rather than a hope shipped with everything else.
 *
 * `unsafe-inline` and `unsafe-eval` appear NOWHERE in the enforced policy.
 * `unsafe-eval` is present in the report-only policy in development only,
 * because React uses `eval` there to reconstruct server-side error stacks;
 * neither React nor Next uses it in production.
 */
function buildCsp(nonce: string): { enforced: string; reportOnly: string } {
  const isDev = process.env.NODE_ENV === 'development'

  /**
   * PRODUCT MEDIA IS SAME-ORIGIN NOW, SO `img-src` AND `media-src` NO LONGER
   * NAME A CDN.
   *
   * Every asset is served through `/api/media/<id>` after a session check, so
   * `'self'` covers all of it. The previous policy had to allow
   * `*.public.blob.vercel-storage.com` — which was both necessary and an
   * admission, recorded in the comment that used to be here, that the host was
   * a public CDN naming it could not make private.
   *
   * The upload host is still named in `connect-src`, and only there: the
   * browser PUTs bytes straight to Blob during an admin upload (a 150 MB video
   * cannot pass through a serverless function). BOTH host shapes appear because
   * a private store answers on `*.private.…` while `blob.vercel-storage.com` is
   * the control plane the SDK talks to first.
   *
   * `blob:` remains in `img-src` for the local object URLs the upload widget
   * creates to preview a file before it is sent. That is a same-document
   * reference to bytes already in the page, not a network origin.
   */
  const blobUpload =
    'https://*.private.blob.vercel-storage.com https://blob.vercel-storage.com'

  const enforced = [
    "object-src 'none'",
    "base-uri 'self'",
    /**
     * Forms may only post to this origin. A meaningful control on a site whose
     * every mutation is a Server Action POST — it means an injected form cannot
     * exfiltrate a submission to another host.
     */
    "form-action 'self'",
    /** No embedding, anywhere. The storefront is never framed. */
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')

  const reportOnly = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "media-src 'self'",
    /** Client-side Blob uploads PUT directly to the storage host. */
    `connect-src 'self' ${blobUpload}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')

  return { enforced, reportOnly }
}

function withSecurityHeaders(
  response: NextResponse,
  pathname: string,
  nonce: string,
): NextResponse {
  const csp = buildCsp(nonce)
  response.headers.set('Content-Security-Policy', csp.enforced)
  response.headers.set('Content-Security-Policy-Report-Only', csp.reportOnly)

  /**
   * NOTHING ON A PRIVATE STOREFRONT IS INDEXABLE.
   *
   * `X-Robots-Tag` is applied to every response rather than relying on per-page
   * `robots` metadata, because metadata only exists on pages somebody
   * remembered to annotate, and a missed one is a product name in a search
   * index. This is belt-and-braces to the authentication wall — a crawler
   * cannot reach these pages anyway — but defence in depth is cheap here and
   * the failure it guards against is permanent and public.
   *
   * `robots.txt` is NOT a security control and is not treated as one. It is a
   * request. Authentication is the boundary.
   */
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')

  /**
   * Token-bearing URLs are never stored.
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
   *
   * THE EXCLUSIONS ARE NOT A PRIVACY HOLE, AND THE REASON CHANGED IN THIS
   * RELEASE. `_next/static` holds compiled bundles, not customer data. Product
   * media used to be excluded from this concern because it lived on a public
   * CDN; it is now served from `/api/media/<id>` on THIS origin, which the
   * matcher does cover — and which authenticates in its own handler regardless,
   * because the proxy is optimistic and never the control.
   *
   * The file-extension exclusion at the end matches literal static files such as
   * `/favicon.ico` and `/logo.png`. It cannot match a media route: those paths
   * are `/api/media/<uuid>` and carry no extension.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
