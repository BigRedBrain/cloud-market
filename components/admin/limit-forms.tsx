'use client'

import { useState } from 'react'

import { AuthForm } from '@/components/auth/auth-form'
import { Field, Input, Textarea } from '@/components/ui/field'
import { Alert } from '@/components/ui/feedback'
import { publishLimitRuleAction } from '@/lib/orders/limit-actions'

/**
 * The publish form.
 *
 * Every control is deliberately plain. This screen is used rarely, under
 * pressure, by someone who will be asked to justify what they typed — so it
 * favours legibility and a slow, explicit confirmation over convenience. There
 * is no autosave, no inline edit and no "apply to all classes" shortcut.
 *
 * The current values are shown beside the inputs rather than pre-filled into
 * them. Pre-filling invites a one-character edit to a legal cap; retyping the
 * whole rule is the point.
 */

type CurrentRule = {
  cannabisClass: string
  version: number
  equivalentGramsPerGram: string
  dailyEquivalentGramsCap: string
  dailyConcentrateGramsCap: string | null
}

export function PublishRuleForm({
  classes,
  current,
}: {
  classes: readonly string[]
  current: CurrentRule[]
}) {
  const [selected, setSelected] = useState(classes[0] ?? '')
  const [timing, setTiming] = useState<'now' | 'scheduled'>('now')
  const live = current.find((rule) => rule.cannabisClass === selected)

  return (
    <AuthForm
      action={publishLimitRuleAction}
      submitLabel="Publish new rule version"
      pendingLabel="Publishing"
      successMessage="Published. The previous version was closed, not overwritten."
    >
      {(fieldErrors) => (
        <>
          <Alert tone="warning" title="This cannot be undone">
            Publishing inserts a new rule and closes the current one. Nothing is
            edited and nothing is deleted — a mistake is corrected by publishing
            again, and both versions stay on the record.
          </Alert>

          <Field
            id="cannabisClass"
            label="Cannabis class"
            error={fieldErrors?.cannabisClass?.[0]}
            required
            hint={
              live
                ? `In force: v${live.version} — factor ${live.equivalentGramsPerGram}, ` +
                  `cap ${live.dailyEquivalentGramsCap}g, concentrate ` +
                  `${live.dailyConcentrateGramsCap ?? 'none'}`
                : 'No rule is in force for this class yet.'
            }
          >
            {(props) => (
              <select
                {...props}
                name="cannabisClass"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="h-11 w-full rounded-md border-solid border-ink bg-ink-700 px-3 font-sans text-base text-cream [border-width:var(--outline-ink)]"
              >
                {classes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field
            id="equivalentGramsPerGram"
            label="Equivalence factor (grams of cannabis-equivalent per gram)"
            error={fieldErrors?.equivalentGramsPerGram?.[0]}
            hint="Flower is normally 1. Concentrate is weighted higher."
            required
          >
            {(props) => (
              <Input {...props} name="equivalentGramsPerGram" inputMode="decimal" />
            )}
          </Field>

          <Field
            id="dailyEquivalentGramsCap"
            label="Daily cannabis-equivalent cap (grams)"
            error={fieldErrors?.dailyEquivalentGramsCap?.[0]}
            required
          >
            {(props) => (
              <Input {...props} name="dailyEquivalentGramsCap" inputMode="decimal" />
            )}
          </Field>

          <Field
            id="dailyConcentrateGramsCap"
            label="Daily concentrate cap (grams)"
            error={fieldErrors?.dailyConcentrateGramsCap?.[0]}
            hint="Leave blank for no separate concentrate cap."
          >
            {(props) => (
              <Input {...props} name="dailyConcentrateGramsCap" inputMode="decimal" />
            )}
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-sans text-sm leading-none font-semibold text-cream">
              Takes effect
            </legend>

            <label className="flex items-center gap-3 font-sans text-sm text-cream">
              <input
                type="radio"
                name="timing"
                value="now"
                checked={timing === 'now'}
                onChange={() => setTiming('now')}
                className="size-4"
              />
              Immediately on publishing
            </label>

            <label className="flex items-center gap-3 font-sans text-sm text-cream">
              <input
                type="radio"
                name="timing"
                value="scheduled"
                checked={timing === 'scheduled'}
                onChange={() => setTiming('scheduled')}
                className="size-4"
              />
              At a scheduled date and time
            </label>

            {timing === 'scheduled' && (
              <Field
                id="effectiveFrom"
                label="Scheduled for"
                error={fieldErrors?.effectiveFrom?.[0]}
                hint="Server time (UTC). Checkout keeps using the current rule until then."
                required
              >
                {(props) => <Input {...props} name="effectiveFrom" type="datetime-local" />}
              </Field>
            )}
          </fieldset>

          <Field
            id="changeReason"
            label="Reason for this change"
            error={fieldErrors?.changeReason?.[0]}
            hint="At least 20 characters. This is the audit record — cite the authority or the advice."
            required
          >
            {(props) => <Textarea {...props} name="changeReason" rows={3} />}
          </Field>

          <Field
            id="confirmClass"
            label={`Type "${selected}" to confirm`}
            error={fieldErrors?.confirmClass?.[0]}
            hint="Confirms which rule you are changing."
            required
          >
            {(props) => <Input {...props} name="confirmClass" autoComplete="off" />}
          </Field>

          <div className="flex items-start gap-3">
            <input
              id="acknowledgeImmutable"
              name="acknowledgeImmutable"
              type="checkbox"
              className="mt-1 size-5 shrink-0 rounded border-solid border-ink bg-ink-700 [border-width:var(--outline-ink)]"
            />
            <label htmlFor="acknowledgeImmutable" className="font-sans text-sm text-cream">
              I understand this version is permanent and cannot be edited or
              deleted.
              {fieldErrors?.acknowledgeImmutable?.[0] && (
                <span role="alert" className="mt-1 block font-semibold text-flare">
                  {fieldErrors.acknowledgeImmutable[0]}
                </span>
              )}
            </label>
          </div>

          <Field
            id="password"
            label="Your password"
            error={fieldErrors?.password?.[0]}
            hint="Re-entered to confirm you are present for this change."
            required
          >
            {(props) => (
              <Input
                {...props}
                name="password"
                type="password"
                autoComplete="current-password"
              />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}
