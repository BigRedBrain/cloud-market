'use client'

import { useEffect } from 'react'

/**
 * Last-resort boundary for errors thrown in the root layout itself.
 *
 * Because it replaces the root layout when it renders, it must supply its own
 * `<html>` and `<body>`. It also cannot rely on the app's fonts or global
 * stylesheet loading successfully, so styling here is inline and minimal by
 * design rather than by omission.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    console.error('Root layout error:', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          backgroundColor: '#fdfdfb',
          color: '#22302a',
        }}
      >
        <main style={{ maxWidth: '28rem', padding: '0 1.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
            CloudMarket is temporarily unavailable
          </h1>
          <p style={{ marginTop: '0.75rem', lineHeight: 1.6, color: '#5c6b63' }}>
            Please refresh the page. If the problem continues, try again shortly.
          </p>
          {error.digest ? (
            <p
              style={{
                marginTop: '1.5rem',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.75rem',
                color: '#5c6b63',
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}
