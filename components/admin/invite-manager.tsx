'use client'

import { useActionState, useState } from 'react'

import { createInviteAction, deactivateInviteAction } from '@/lib/invites/admin-actions'
import { inviteStatusLabel, type InviteStatus } from '@/lib/invites/status'
import type { InviteListRow } from '@/lib/invites/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { Field, Input } from '@/components/ui/field'

/**
 * Invite administration UI.
 *
 * A Client Component because the create form has one requirement that cannot be
 * met by a redirect-and-render flow: THE RAW CODE IS RETURNED EXACTLY ONCE, in
 * the action result, and must be held in memory long enough for the operator to
 * copy it. Redirecting would discard it, and persisting it to show on the next
 * page load is precisely what the hashed storage exists to prevent.
 *
 * Everything security-relevant still happens server-side. This component renders
 * what the actions return; it decides nothing.
 */

function StatusBadge({ status }: { status: InviteStatus }) {
  const variant =
    status === 'active' ? 'volt' : status === 'deactivated' ? 'flare' : 'smoke'

  return <Badge variant={variant}>{inviteStatusLabel(status)}</Badge>
}

function formatDate(value: Date | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * The one-time code reveal.
 *
 * Deliberately loud, deliberately hard to dismiss by accident, and deliberately
 * explicit that this is the only viewing. An operator who closes this without
 * copying has to issue a replacement — there is no column holding the code and
 * no function that can reconstruct it.
 */
function CodeReveal({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)

  return (
    <Alert tone="warning" title="Copy this code now — it will not be shown again">
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          Cloud Market stores only a keyed hash of this code. Nobody, including
          an administrator, can retrieve it later. If you lose it, deactivate
          this invite and issue a replacement.
        </p>

        <code className="panel-sm block overflow-x-auto rounded-md bg-ink-900 px-3 py-2.5 font-mono text-sm font-bold tracking-wider text-volt select-all">
          {code}
        </code>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              /**
               * `navigator.clipboard` is unavailable over plain HTTP and in some
               * embedded browsers. The code is rendered with `select-all` above
               * precisely so that manual selection always works — the button is
               * a convenience, and its failure is reported rather than swallowed.
               */
              navigator.clipboard
                ?.writeText(code)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }}
          >
            {copied ? 'Copied' : 'Copy invite code'}
          </Button>

          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            I have saved it
          </Button>
        </div>
      </div>
    </Alert>
  )
}

export function CreateInviteForm() {
  const [state, formAction, pending] = useActionState(createInviteAction, null)
  const [dismissed, setDismissed] = useState(false)

  const code = state?.ok ? state.data.code : null
  const errors = state && !state.ok ? state.fieldErrors : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create invite</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {code && !dismissed && (
          <CodeReveal code={code} onDismiss={() => setDismissed(true)} />
        )}

        {state && !state.ok && (
          <Alert tone="error" title="Could not create invite">
            {state.message}
          </Alert>
        )}

        <form
          action={(formData) => {
            /** A new submission supersedes the previous reveal. */
            setDismissed(false)
            formAction(formData)
          }}
          className="flex flex-col gap-5"
        >
          <Field
            id="label"
            label="Label"
            hint="For your own reference — never shown to the recipient."
            error={errors?.label?.[0]}
          >
            {(props) => (
              <Input name="label" maxLength={120} placeholder="Nov flyer" {...props} />
            )}
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="maxUses"
              label="Maximum uses"
              hint="1 for a personal invite."
              error={errors?.maxUses?.[0]}
              required
            >
              {(props) => (
                <Input
                  type="number"
                  name="maxUses"
                  min={1}
                  max={500}
                  defaultValue={1}
                  inputMode="numeric"
                  {...props}
                />
              )}
            </Field>

            <Field
              id="expiresAt"
              label="Expires"
              hint="Leave blank for no expiry."
              error={errors?.expiresAt?.[0]}
            >
              {(props) => <Input type="date" name="expiresAt" {...props} />}
            </Field>
          </div>

          <div>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Creating…' : 'Create invite'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function DeactivateButton({ inviteId }: { inviteId: string }) {
  const [state, formAction, pending] = useActionState(deactivateInviteAction, null)

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="inviteId" value={inviteId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Deactivating…' : 'Deactivate'}
      </Button>
      {state && !state.ok && (
        <span className="ml-2 font-mono text-xs text-flare">{state.message}</span>
      )}
    </form>
  )
}

export function InviteTable({ invites }: { invites: InviteListRow[] }) {
  if (invites.length === 0) {
    return (
      <p className="font-mono text-sm text-smoke">
        No invites yet. Create one above to let somebody register.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Invite codes, showing only a masked prefix. The full code is displayed
          once at creation and is never recoverable.
        </caption>
        <thead>
          <tr className="border-b-2 border-ink text-smoke">
            <th scope="col" className="px-3 py-2 font-normal">Code</th>
            <th scope="col" className="px-3 py-2 font-normal">Status</th>
            <th scope="col" className="px-3 py-2 font-normal">Label</th>
            <th scope="col" className="px-3 py-2 font-normal">Uses</th>
            <th scope="col" className="px-3 py-2 font-normal">Expires</th>
            <th scope="col" className="px-3 py-2 font-normal">Created</th>
            <th scope="col" className="px-3 py-2 font-normal">By</th>
            <th scope="col" className="px-3 py-2 font-normal">Last used</th>
            <th scope="col" className="px-3 py-2 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            <tr key={invite.id} className="border-b border-ink-600">
              <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-white">
                {invite.maskedCode}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={invite.status} />
              </td>
              <td className="px-3 py-2 text-smoke">{invite.label ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs text-white">
                {invite.useCount} / {invite.maxUses}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-smoke">
                {formatDate(invite.expiresAt)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-smoke">
                {formatDate(invite.createdAt)}
              </td>
              <td className="px-3 py-2 text-xs text-smoke">
                {invite.createdByEmail ?? '—'}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-smoke">
                {formatDate(invite.lastRedeemedAt)}
              </td>
              <td className="px-3 py-2 text-right">
                {invite.status !== 'deactivated' && (
                  <DeactivateButton inviteId={invite.id} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
