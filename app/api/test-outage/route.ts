import { NextResponse } from 'next/server'

import { setSimulatedOutage } from '@/lib/email'
import { serverEnv } from '@/lib/env'

/**
 * Simulates an email-provider outage, for tests only.
 *
 * WHY A ROUTE AND NOT AN ENV VAR: the outage has to be switched on and off
 * within a single suite run, against a server that is already running. An env
 * var would require a restart and would leave the whole run degraded.
 *
 * WHY IT IS SAFE: 404 unless BOTH conditions hold — not production, and the
 * capture transport is selected. Production can only ever use `resend`
 * (lib/email/index.ts refuses anything else), so this route does not exist
 * there, and it answers with the same response a nonexistent route gives.
 */
function guard(): boolean {
  const env = serverEnv()
  return env.NODE_ENV !== 'production' && env.EMAIL_PROVIDER === 'capture'
}

const unavailable = () => new NextResponse('Not found', { status: 404 })

export async function POST() {
  if (!guard()) return unavailable()
  setSimulatedOutage(true)
  return NextResponse.json({ outage: true })
}

export async function DELETE() {
  if (!guard()) return unavailable()
  setSimulatedOutage(false)
  return NextResponse.json({ outage: false })
}
