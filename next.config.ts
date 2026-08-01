import type { NextConfig } from 'next'

/**
 * Cloud Market — Next.js configuration.
 *
 * Targets Next.js 16. Notable version-specific choices:
 *  - Turbopack is the default bundler for `dev` and `build`; no flags needed.
 *  - `typedRoutes` is stable in 16 (no longer under `experimental`).
 *  - `cacheComponents` (the successor to `experimental.ppr` / `dynamicIO`) is
 *    deliberately NOT enabled yet — see the note at the bottom of this file.
 */

const securityHeaders = [
  // Disallow MIME sniffing.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Prevent clickjacking of the storefront and admin dashboard.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Send only the origin to third parties (e.g. Google Maps).
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Deny access to hardware APIs the app never uses. Geolocation stays enabled
  // for same-origin because Phase 7 delivery tracking depends on it.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), payment=(), geolocation=(self)',
  },
  // Force HTTPS for two years, including subdomains.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
]

/**
 * Applied only to routes whose path carries a one-time token. `Referrer-Policy`
 * overrides the site-wide `strict-origin-when-cross-origin`, which would still
 * emit the origin — harmless generally, but these URLs deserve the strictest
 * setting available.
 */
const TOKEN_URL_HEADERS = [
  { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
  { key: 'Pragma', value: 'no-cache' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Statically typed `href` values for Link and router calls.
  typedRoutes: true,

  // The framework advertising its own version is free reconnaissance.
  poweredByHeader: false,

  images: {
    remotePatterns: [
      {
        // Product imagery served from Vercel Blob.
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com',
        pathname: '/**',
      },
    ],
    // Next 16 defaults `qualities` to [75]; declared explicitly so the
    // storefront can serve sharper hero/product photography.
    qualities: [75, 90],
  },

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      /**
       * Routes whose URL contains a bearer token.
       *
       * The token has to travel in the URL — it arrives by email, and there is
       * nowhere else to put it. What can be controlled is everything downstream
       * of that:
       *
       *  - `no-store` keeps the page out of the browser's disk cache and out of
       *    any intermediary's, so the token-bearing response is not sitting on
       *    a shared machine after the fact.
       *  - `no-referrer` stops the full URL leaking in a `Referer` header. A
       *    single third-party asset on one of these pages would otherwise hand
       *    a live credential to someone else's server. There are no third-party
       *    assets on them, and this is the belt to that braces.
       *
       * Neither header makes the URL a secret — browser history, proxy logs and
       * corporate TLS inspection can still record it. That is precisely why the
       * TTL is short and the token is single-use: exposure is assumed, and the
       * window is what gets minimised.
       */
      {
        source: '/verify-email/:token*',
        headers: TOKEN_URL_HEADERS,
      },
      {
        source: '/reset-password/:token*',
        headers: TOKEN_URL_HEADERS,
      },
    ]
  },

  typescript: {
    // Never ship a build that does not typecheck.
    ignoreBuildErrors: false,
  },

  experimental: {
    /**
     * Enables `forbidden()` and `unauthorized()` from `next/navigation`, which
     * render the `forbidden.tsx` / `unauthorized.tsx` segments and return real
     * 403/401 statuses.
     *
     * This is the one experimental flag the project enables, and it is a
     * considered exception to the conservatism below. The alternative — a
     * redirect to an ordinary page — returns 200 for an authorization failure,
     * which is wrong for API consumers, wrong for monitoring, and wrong for
     * anything that reads status codes.
     *
     * The failure mode if the API changes is a build-time import error: loud,
     * immediate, and impossible to ship past. That is an acceptable risk in a
     * way that a silently-degrading auth path would not be.
     */
    authInterrupts: true,
  },
}

export default nextConfig

/**
 * Deferred decisions, recorded so they are revisited deliberately:
 *
 * 1. `cacheComponents: true` — Next 16's replacement for Partial Prerendering.
 *    It is a strong fit for the product catalog (Phase 3), where a mostly
 *    static page shells around a dynamic cart badge. Deferred to that phase
 *    because enabling it changes caching semantics for every route at once,
 *    and there is not yet enough surface area to validate it against.
 *
 * 2. `reactCompiler: true` — stable in 16, but relies on Babel and measurably
 *    slows builds. Revisit once there are enough Client Components for the
 *    automatic memoization to pay for itself.
 *
 * 3. Content-Security-Policy — intentionally absent. A meaningful CSP for this
 *    app needs a per-request nonce, which belongs in `proxy.ts` (Phase 1), and
 *    must account for Google Maps. A header-only CSP now would either be too
 *    loose to matter or break Maps in production.
 */
