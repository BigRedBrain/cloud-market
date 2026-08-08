'use client'

import { useActionState, useState, useTransition } from 'react'

import {
  assignBackupAdminAction,
  removeBackupAdminAction,
  searchBackupCandidatesAction,
} from '@/lib/admin/backup-admin'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { Field, Input } from '@/components/ui/field'

/**
 * The owner's backup-administrator controls.
 *
 * THE BACKUP ADMINISTRATOR NEVER SEES THIS COMPONENT. The page that renders it
 * calls `requireOwner()`, the actions it calls each call `requireOwner()`
 * independently, and the nav tab that links to it is owner-gated. Three layers,
 * and only the second one is load-bearing — the other two are so that a backup
 * administrator is not shown a door they cannot open.
 */

type Candidate = { id: string; email: string; name: string | null }

/**
 * Two-step assignment: search, then confirm a specific account.
 *
 * NOT ONE STEP, AND THE SPLIT IS THE POINT. Typing an email into a box and
 * pressing "promote" means the operator never sees which ACCOUNT they matched —
 * two customers with similar addresses, or a typo that happens to match someone
 * else, and administrative access has gone to the wrong person. The selected
 * account is displayed in full, with its id, before the password is even asked
 * for.
 */
function AssignBackupForm() {
  const [state, formAction, pending] = useActionState(assignBackupAdminAction, null)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [searching, startSearch] = useTransition()
  const [searchError, setSearchError] = useState<string | null>(null)

  const errors = state && !state.ok ? state.fieldErrors : undefined

  function runSearch() {
    setSearchError(null)
    startSearch(async () => {
      const result = await searchBackupCandidatesAction(query)
      if (result.ok) {
        setCandidates(result.data)
        if (result.data.length === 0) setSearchError('No matching verified account.')
      } else {
        setCandidates([])
        setSearchError(result.message)
      }
    })
  }

  if (state?.ok) {
    return (
      <Alert tone="success" title="Backup administrator assigned">
        The slot is now filled. Reload to see the current state.
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {state && !state.ok && (
        <Alert tone="error" title="Could not assign">
          {state.message}
        </Alert>
      )}

      {/* ---- Step 1: find the account ------------------------------------ */}
      <div className="flex flex-col gap-3">
        <Field
          id="candidate-search"
          label="Find an account"
          hint="Search by email or name. Only active accounts with a verified email address are eligible."
        >
          {(props) => (
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  /** This input lives outside the promotion form; Enter must
                      search, never submit something else. */
                  event.preventDefault()
                  runSearch()
                }
              }}
              autoComplete="off"
              placeholder="name@example.com"
              {...props}
            />
          )}
        </Field>

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runSearch}
            disabled={searching || query.trim().length < 3}
          >
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>

        {searchError && <p className="font-mono text-xs text-flare">{searchError}</p>}

        {candidates.length > 0 && (
          <ul className="flex flex-col gap-2">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => setSelected(candidate)}
                  className={`panel-sm w-full rounded-md px-3 py-2 text-left transition-colors ${
                    selected?.id === candidate.id
                      ? 'bg-ember/20 text-white'
                      : 'bg-ink-800 text-smoke hover:bg-white/5'
                  }`}
                >
                  <span className="block text-sm font-semibold text-white">
                    {candidate.name ?? 'No name on file'}
                  </span>
                  <span className="block font-mono text-xs">{candidate.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Step 2: confirm ---------------------------------------------- */}
      {selected && (
        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="userId" value={selected.id} />

          <Alert tone="warning" title="Confirm the account">
            <div className="flex flex-col gap-1 text-sm">
              <p>
                <strong className="text-white">{selected.name ?? 'No name'}</strong>{' '}
                — <span className="font-mono">{selected.email}</span>
              </p>
              {/* The id is shown because two accounts can share a display name
                  and an operator confirming an irreversible privilege change
                  deserves the unambiguous identifier. */}
              <p className="font-mono text-xs text-smoke">{selected.id}</p>
              <p className="mt-2">
                This account will be able to manage products, media, invites and
                orders. It will NOT be able to appoint another administrator,
                change the owner, configure payments, or issue refunds.
              </p>
            </div>
          </Alert>

          <Field
            id="reason"
            label="Reason"
            hint="Recorded in the audit log."
            error={errors?.reason?.[0]}
          >
            {(props) => (
              <Input name="reason" maxLength={300} placeholder="Cover for November" {...props} />
            )}
          </Field>

          <Field
            id="assign-password"
            label="Confirm your password"
            hint="Required because this changes who can administer the store."
            error={errors?.password?.[0]}
            required
          >
            {(props) => (
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                {...props}
              />
            )}
          </Field>

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Assigning…' : 'Assign backup administrator'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function RemoveBackupForm({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(removeBackupAdminAction, null)
  const [confirming, setConfirming] = useState(false)

  const errors = state && !state.ok ? state.fieldErrors : undefined

  if (state?.ok) {
    return (
      <Alert tone="success" title="Backup administrator removed">
        The account is a customer again and every one of its sessions has been
        signed out. Reload to see the current state.
      </Alert>
    )
  }

  if (!confirming) {
    return (
      <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
        Remove backup administrator
      </Button>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state && !state.ok && (
        <Alert tone="error" title="Could not remove">
          {state.message}
        </Alert>
      )}

      <Alert tone="warning" title={`Remove ${email}?`}>
        Their administrative access ends immediately and every session they hold
        is destroyed. Their account, orders and history are kept — they become an
        ordinary customer.
      </Alert>

      <Field
        id="remove-reason"
        label="Reason"
        hint="Recorded in the audit log."
        error={errors?.reason?.[0]}
      >
        {(props) => <Input name="reason" maxLength={300} {...props} />}
      </Field>

      <Field
        id="remove-password"
        label="Confirm your password"
        error={errors?.password?.[0]}
        required
      >
        {(props) => (
          <Input type="password" name="password" autoComplete="current-password" {...props} />
        )}
      </Field>

      <div className="flex gap-2">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? 'Removing…' : 'Confirm removal'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function AdminAccessManager({
  backup,
}: {
  backup: { email: string; name: string | null; assignedAt: Date } | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {backup ? 'Backup administrator' : 'No backup administrator'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {backup ? (
          <>
            <dl className="grid gap-2 font-mono text-sm">
              <div className="flex justify-between gap-4 border-b border-ink-600 py-2">
                <dt className="text-smoke">Account</dt>
                <dd className="text-white">{backup.email}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-ink-600 py-2">
                <dt className="text-smoke">Name</dt>
                <dd className="text-white">{backup.name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-smoke">Assigned</dt>
                <dd className="text-white">
                  {new Date(backup.assignedAt).toLocaleString('en-US')}
                </dd>
              </div>
            </dl>

            <RemoveBackupForm email={backup.email} />
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-smoke">
              The single backup slot is empty. You are currently the only person
              who can administer Cloud Market. Assigning a backup is optional —
              and there is exactly one slot, so it can never become two.
            </p>
            <AssignBackupForm />
          </>
        )}
      </CardContent>
    </Card>
  )
}
