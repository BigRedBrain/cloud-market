'use client'

import { useEffect } from 'react'

/**
 * Route-level error boundary.
 *
 * Must be a Client Component — React needs to attach it as an error boundary on
 * the client. In production `error.message` is replaced by React with a generic
 * string and a `digest` that correlates to the server log, so nothing sensitive
 * reaches the browser.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Replaced with the observability client in Phase 8.
    console.error('Unhandled route error:', error)
  }, [error])

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          We hit an unexpected problem loading this page. Your cart and account
          are safe.
        </p>

        {error.digest ? (
          <p className="text-muted-foreground mt-6 font-mono text-xs">
            Reference: {error.digest}
          </p>
        ) : null}

        <button
          type="button"
          onClick={reset}
          className="bg-primary text-primary-foreground focus-visible:ring-ring mt-8 inline-flex h-10 items-center justify-center rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    </main>
  )
}
