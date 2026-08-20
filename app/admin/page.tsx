import type { Metadata } from 'next'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
}

/**
 * Admin landing.
 *
 * 5% brand intensity (DESIGN.md §9): type, hairlines, tabular data. Information
 * density wins outright — no smoke, no halftone, no decorative motion. What the
 * intensity scale does not scale down still applies unchanged: focus rings,
 * press physics, and contrast are identical to the hero.
 *
 * Deliberately minimal. This exists so the `requireAdmin` role gate is
 * exercised by a real route rather than only by unit assertions; the actual
 * admin surface is Phase 2 work.
 */
export default async function AdminPage() {
  const admin = await requireAdmin()

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-6 font-poster text-2xl tracking-tight text-white uppercase">
        Admin
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>Signed in as administrator</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 font-mono text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-smoke">Account</span>
            <span className="text-white">{admin.email}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-smoke">Role</span>
            <span className="text-white">{admin.role}</span>
          </div>
          <p className="mt-3 font-ui text-xs text-smoke">
            Product, inventory and category management arrive in Phase 2.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
