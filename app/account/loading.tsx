import { Card } from '@/components/ui/card'

/**
 * Streaming fallback for the account pages.
 *
 * Exists so the outlet is never empty. The layout is synchronous now, so this
 * should rarely be seen — but a slow session lookup or a slow profile query can
 * still delay the page segment, and "briefly quiet" is a better answer than
 * "briefly blank" on a page the customer reached deliberately.
 *
 * 10% brand intensity, matching the shell it appears inside: outlines and
 * neutral blocks, no smoke, no halftone, no motion. Deliberately NOT animated —
 * a pulse here would be decoration on a surface whose whole job is to get out
 * of the way, and DESIGN.md §9 keeps movement for the brand surfaces.
 *
 * `aria-busy` and the visually hidden line tell a screen reader what the blocks
 * cannot.
 */
export default function AccountLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Loading your account…</span>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-8 w-40 rounded-md bg-white/10" />
        <div className="h-6 w-28 rounded-md bg-white/5" />
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-5">
          <div className="h-4 w-24 rounded bg-white/10" />
          <div className="h-11 w-full rounded-md bg-white/5" />
          <div className="h-4 w-24 rounded bg-white/10" />
          <div className="h-11 w-full rounded-md bg-white/5" />
          <div className="h-11 w-32 rounded-md bg-white/10" />
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex flex-col gap-3">
          <div className="h-5 w-36 rounded bg-white/10" />
          <div className="h-4 w-full rounded bg-white/5" />
          <div className="h-4 w-2/3 rounded bg-white/5" />
        </div>
      </Card>
    </div>
  )
}
