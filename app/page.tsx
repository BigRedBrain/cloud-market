/**
 * Placeholder landing page.
 *
 * Phase 0 ships infrastructure, not the storefront. This page exists to prove
 * the design tokens, fonts and layout shell render correctly end to end; it is
 * replaced by the real catalog in Phase 3.
 */
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-xl">
        <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
          Phase 0 · Foundation
        </p>

        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance">
          Cloud Market
        </h1>

        <p className="text-muted-foreground mt-4 leading-relaxed text-pretty">
          A licensed Michigan cannabis dispensary. Ordering, pickup and delivery
          are being built out phase by phase.
        </p>

        <dl className="border-border mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
          {[
            { label: 'Framework', value: 'Next.js 16' },
            { label: 'Database', value: 'Neon · Drizzle' },
            { label: 'Status', value: 'Pre-launch' },
          ].map((item) => (
            <div key={item.label} className="bg-card px-4 py-3">
              <dt className="text-muted-foreground text-xs">{item.label}</dt>
              <dd className="mt-1 text-sm font-medium">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  )
}
