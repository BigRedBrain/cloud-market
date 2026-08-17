import type { Metadata, Viewport } from 'next'
import { Anton, Archivo, Permanent_Marker, Space_Mono } from 'next/font/google'

import { AnnouncementBar } from '@/components/cms/announcement-bar'
import { clientEnv } from '@/lib/env'
import './globals.css'

/**
 * Four faces, four jobs.
 *
 * Permanent Marker — the CloudMarket brand voice. Hero headlines, comic
 * callouts, promotional display type, and the wordmark's typographic echo.
 * Single weight, no italic, and a marker texture that closes up fast, so it is
 * reserved for large branded moments. Per the master spec it must never carry
 * prices, potency figures, inventory, form labels, legal copy, admin or vendor
 * table data, long prose, or small utility text — and never takes negative
 * letter-spacing (see the exception in globals.css).
 *
 * Anton — poster display. A condensed weight that carries flyer/comic-cover
 * energy at section-heading scale, where Permanent Marker would shout. It has
 * one weight and no italic, which is a feature: it forces headings to stay
 * short. Never used below ~1.5rem, never for prose.
 *
 * Archivo — everything readable. A variable grotesque with a wide weight range
 * and a large x-height, which is what keeps dense product copy and checkout
 * fields legible at 14–16px on a phone at night.
 *
 * Space Mono — data with character. Prices, weights, THC percentages, licence
 * and order numbers. Its quirks read as street-print rather than terminal, and
 * fixed advance widths stop totals jittering as they update.
 *
 * The `--font-display` / `--font-sans` / `--font-mono` variable names are kept
 * exactly as they were so every existing `font-display` / `font-sans` /
 * `font-mono` utility keeps resolving. globals.css layers the CloudMarket
 * semantic names (`--font-brand` / `--font-poster` / `--font-ui` /
 * `--font-data`) on top of them additively.
 */
const brand = Permanent_Marker({
  variable: '--font-brand',
  subsets: ['latin'],
  // Permanent Marker is not a variable font, so a weight is required.
  weight: '400',
  display: 'swap',
})

const display = Anton({
  variable: '--font-display',
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
})

const sans = Archivo({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
})

const mono = Space_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  /**
   * Required for Open Graph and canonical URLs to resolve absolutely. Without
   * it, social previews break on every deployed environment.
   */
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: 'Cloud Market — Michigan Cannabis Delivery',
    template: '%s · Cloud Market',
  },
  description:
    'Browse and order cannabis from our licensed Michigan dispensary, with pickup and delivery where legally available.',
  applicationName: 'Cloud Market',
  robots: {
    // Age-restricted commerce: allow indexing, but keep image previews out of
    // search result pages.
    index: true,
    follow: true,
    'max-image-preview': 'none',
  },
}

/**
 * Incremental revalidation — the piece that makes scheduled publishing real.
 *
 * CMS content is resolved from a publishing window at read time, but a
 * STATICALLY prerendered page is rendered once at build and never again. A
 * campaign scheduled for Friday 9am would therefore never appear: nothing
 * re-renders the page when the clock passes.
 *
 * Sixty seconds is the trade. Admin edits are instant regardless — the actions
 * call `revalidatePath` — so this window only bounds *time-based* transitions:
 * a scheduled campaign goes live within a minute of its start, and an expiring
 * one disappears within a minute of its end. Shorter would cost cache hits for
 * precision nobody needs on a storefront banner.
 *
 * Set on the root layout so it covers the announcement bar on every route.
 */
export const revalidate = 60

export const viewport: Viewport = {
  // Brand is dark-first; there is no light theme to switch to.
  themeColor: '#121214',
  colorScheme: 'dark',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark ${brand.variable} ${display.variable} ${sans.variable} ${mono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <AnnouncementBar />
        {children}
      </body>
    </html>
  )
}
