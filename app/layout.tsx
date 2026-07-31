import type { Metadata, Viewport } from 'next'
import { Anton, Archivo, Space_Mono } from 'next/font/google'

import { clientEnv } from '@/lib/env'
import './globals.css'

/**
 * Three faces, three jobs.
 *
 * Anton — display only. A condensed poster weight that carries the flyer/comic
 * cover energy the brand is built on. It has one weight and no italic, which is
 * a feature: it forces headlines to stay short and loud instead of sprawling.
 * Never used below ~1.5rem, never for prose.
 *
 * Archivo — everything readable. A variable grotesque with a wide weight range
 * and a large x-height, which is what keeps dense product copy and checkout
 * fields legible at 14–16px on a phone at night.
 *
 * Space Mono — data with character. Prices, weights, THC percentages, licence
 * and order numbers. Its quirks read as street-print rather than terminal, and
 * fixed advance widths stop totals jittering as they update.
 */
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
      className={`dark ${display.variable} ${sans.variable} ${mono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
