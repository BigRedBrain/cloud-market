import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'

import { clientEnv } from '@/lib/env'
import './globals.css'

const sans = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
})

const mono = Geist_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdfdfb' },
    { media: '(prefers-color-scheme: dark)', color: '#121a16' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
