import type { MetadataRoute } from 'next'

/**
 * `robots.txt` for a private storefront.
 *
 * ROBOTS.TXT IS NOT A SECURITY CONTROL AND IS NOT TREATED AS ONE HERE. It is a
 * request, honoured by well-behaved crawlers and ignored by everyone else, and
 * it is served to anonymous callers by definition — a crawler cannot read an
 * instruction to go away if reading it requires signing in.
 *
 * It is also, historically, a map. A file that lists `Disallow: /admin`,
 * `Disallow: /checkout`, `Disallow: /orders` tells an attacker exactly where to
 * look, in a file they were invited to read. That is why this one enumerates
 * nothing: a single blanket rule leaks no structure while making the intent
 * unambiguous.
 *
 * THE ACTUAL BOUNDARY IS AUTHENTICATION. Every route outside
 * `lib/auth/public-routes.ts` requires a session, enforced server-side in the
 * Data Access Layer. A crawler that ignores this file reaches sign-in and stops
 * there, exactly like any other anonymous visitor. Belt and braces on top of
 * that, `proxy.ts` sets `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
 * on every response, which covers pages nobody remembered to annotate and does
 * not depend on the crawler having read this file at all.
 *
 * THERE IS DELIBERATELY NO SITEMAP. A sitemap for a private catalog is a
 * published list of every product a private shop sells — the single most
 * damaging file this application could serve. `app/sitemap.ts` does not exist,
 * and no `sitemap` field is declared below, so nothing generates one.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        /**
         * Everything, including the sign-in page. There is nothing on this
         * origin worth indexing: the authentication pages are not content, and
         * indexing them would put the shop's name and branding into search
         * results for a storefront whose whole premise is that you have to be
         * invited to know it is there.
         */
        disallow: '/',
      },
    ],
  }
}
