/**
 * Root streaming fallback.
 *
 * Rendered while a Server Component subtree suspends. Kept deliberately quiet —
 * a full-page spinner on every navigation reads as slower than it is.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 items-center justify-center px-6 py-24"
    >
      <span className="sr-only">Loading</span>
      <div
        aria-hidden
        className="border-muted border-t-primary size-6 animate-spin rounded-full border-2"
      />
    </div>
  )
}
