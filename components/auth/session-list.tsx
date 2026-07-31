'use client'

import { useActionState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import { revokeOtherSessionsAction, revokeSessionAction } from '@/lib/auth/actions'
import type { ActionResult } from '@/lib/result'

/**
 * Active device list.
 *
 * Session revocation is only meaningful if a user can see what to revoke, so
 * each row shows enough to be recognisable — browser, platform, last activity —
 * without exposing anything useful to someone reading over a shoulder. The full
 * user-agent string is deliberately summarised rather than printed.
 *
 * The IP address is shown because "signed in from an address I don't recognise"
 * is the signal that prompts someone to act. It is the user's own data.
 */

export type SessionRow = {
  id: string
  userAgent: string | null
  ipAddress: string | null
  lastUsedAt: string
  createdAt: string
}

/** Turns a user-agent string into something a person can recognise. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'Browser'

  const platform =
    /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'Unknown platform'

  return `${browser} on ${platform}`
}

function RevokeAllButton() {
  /**
   * The server action is passed directly rather than wrapped in an inline
   * arrow. A wrapper is a client-side closure, so Next emits no hidden action
   * fields and the form stops working without JavaScript.
   */
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    revokeOtherSessionsAction,
    null,
  )

  return (
    <form action={action}>
      {state && !state.ok && (
        <Alert tone="error" title="Could not sign out other devices" className="mb-3">
          {state.message}
        </Alert>
      )}
      <Button type="submit" variant="destructive" size="sm">
        Sign out all other devices
      </Button>
    </form>
  )
}

export function SessionList({
  sessions,
  currentSessionId,
}: {
  sessions: SessionRow[]
  currentSessionId: string
}) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    revokeSessionAction,
    null,
  )

  return (
    <div className="flex flex-col gap-4">
      {state && !state.ok && (
        <Alert tone="error" title="Could not sign out that device">
          {state.message}
        </Alert>
      )}

      <ul className="flex flex-col gap-3">
        {sessions.map((session) => {
          const isCurrent = session.id === currentSessionId

          return (
            <li
              key={session.id}
              className="panel-sm flex flex-wrap items-center justify-between gap-3 rounded-md bg-ink-800 p-4"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">
                    {describeDevice(session.userAgent)}
                  </span>
                  {isCurrent && <Badge variant="volt">This device</Badge>}
                </div>
                <p className="font-mono text-xs text-smoke">
                  {session.ipAddress ?? 'Unknown IP'} · last active{' '}
                  {new Date(session.lastUsedAt).toLocaleString()}
                </p>
              </div>

              {!isCurrent && (
                <form action={action}>
                  <input type="hidden" name="sessionId" value={session.id} />
                  <Button type="submit" variant="outline" size="sm">
                    Sign out
                  </Button>
                </form>
              )}
            </li>
          )
        })}
      </ul>

      {sessions.length > 1 && <RevokeAllButton />}
    </div>
  )
}
