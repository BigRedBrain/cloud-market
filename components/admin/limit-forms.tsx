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
 * Current values are shown BESIDE the inputs rather than pre-filled into them.
 * Pre-filling invites a one-character edit to a legal cap; retyping the whole
 * rule is the point.
 *
 * THE CONVERSION IS ENTERED AS A RATIO. 36 fluid ounces of liquid infused
 * product equals one ounce of usable marijuana, which is 28.349523125/36 grams
 * per fluid ounce — not a terminating decimal. A decimal field would publish an
 * approximation of a legal conversion and nothing downstream could tell.
 */

type CurrentRule = {
  cannabisClass: string
  version: number
  equivalence: string
  usableCapGrams: string
  concentrateCapGrams: string
  plantCap: string
  measurementUnit: string
}

type ClassSpec = {
  cannabisClass: string
  unit: string
  basis: string
  countsAsCannabis: boolean
  suggested: { numerator: string; denominator: string; note: string }
}

export function PublishRuleForm({
  classes,
  current,
}: {
  classes: readonly ClassSpec[]
  current: CurrentRule[]
}) {
  const [selected, setSelected] = useState(classes[0]?.cannabisClass ?? '')
  const [timing, setTiming] = useState<'now' | 'scheduled'>('now')
  const [confirming, setConfirming] = useState(false)

  const spec = classes.find((c) => c.cannabisClass === selected)
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
              spec
                ? `Measured in ${spec.unit} (${spec.basis.replace(/_/g, ' ')}). ${spec.suggested.note}`
                : undefined
            }
          >
            {(props) => (
              <select
                {...props}
                name="cannabisClass"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="h-11 w-full rounded-md border-solid border-ink bg-ink-700 px-3 font-ui text-base text-cream [border-width:var(--outline-ink)]"
              >
                {classes.map((c) => (
                  <option key={c.cannabisClass} value={c.cannabisClass}>
                    {c.cannabisClass}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {/*
            The outgoing values, read from the rule actually in force rather
            than from anything the form remembers, so this column cannot be
            stale while the incoming column is fresh.
          */}
          <div className="rounded-md border-solid border-ink bg-ink-800 p-4 [border-width:var(--outline-ink)]">
            <h3 className="mb-3 font-data text-xs tracking-widest text-smoke uppercase">
              Currently in force
            </h3>
            {live ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-data text-xs">
                <dt className="text-smoke">version</dt>
                <dd className="text-white">v{live.version}</dd>
                <dt className="text-smoke">conversion</dt>
                <dd className="text-white">
                  {live.equivalence} per {live.measurementUnit}
                </dd>
                <dt className="text-smoke">usable-equivalent cap</dt>
                <dd className="text-white">{live.usableCapGrams} g</dd>
                <dt className="text-smoke">concentrate cap</dt>
                <dd className="text-white">{live.concentrateCapGrams} g</dd>
                <dt className="text-smoke">immature plant cap</dt>
                <dd className="text-white">{live.plantCap}</dd>
              </dl>
            ) : (
              <p className="text-sm text-flare">
                No rule is in force for this class. Products in it cannot be sold
                until one is published.
              </p>
            )}
          </div>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-1 font-ui text-sm leading-none font-semibold text-cream">
              Conversion to usable-marijuana equivalent
            </legend>
            <p className="font-ui text-sm text-smoke">
              Entered as an exact ratio, applied to the measurement above.
              {spec && (
                <>
                  {' '}
                  Suggested for {spec.cannabisClass}:{' '}
                  <span className="font-data text-white">
                    {spec.suggested.numerator}/{spec.suggested.denominator}
                  </span>
                </>
              )}
            </p>

            <div className="flex gap-4">
              <Field
                id="equivalenceNumerator"
                label="Numerator"
                error={fieldErrors?.equivalenceNumerator?.[0]}
                className="flex-1"
                required
              >
                {(props) => (
                  <Input {...props} name="equivalenceNumerator" inputMode="numeric" />
                )}
              </Field>
              <Field
                id="equivalenceDenominator"
                label="Denominator"
                error={fieldErrors?.equivalenceDenominator?.[0]}
                className="flex-1"
                required
              >
                {(props) => (
                  <Input {...props} name="equivalenceDenominator" inputMode="numeric" />
                )}
              </Field>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-1 font-ui text-sm leading-none font-semibold text-cream">
              Caps — enforced independently, a basket must pass every one
            </legend>

            <Field
              id="usableEquivalentCapGrams"
              label="Usable-marijuana equivalent cap (grams per transaction)"
              error={fieldErrors?.usableEquivalentCapGrams?.[0]}
              hint="2.5 oz is 70.87380781250 g exactly."
              required
            >
              {(props) => (
                <Input {...props} name="usableEquivalentCapGrams" inputMode="decimal" />
              )}
            </Field>

            <Field
              id="concentrateCapGrams"
              label="Concentrate cap (grams per transaction)"
              error={fieldErrors?.concentrateCapGrams?.[0]}
              hint="Separate ceiling. 15 g under current guidance."
              required
            >
              {(props) => <Input {...props} name="concentrateCapGrams" inputMode="decimal" />}
            </Field>

            <Field
              id="immaturePlantCapUnits"
              label="Immature plant cap (units per transaction)"
              error={fieldErrors?.immaturePlantCapUnits?.[0]}
              hint="3 under current guidance."
              required
            >
              {(props) => <Input {...props} name="immaturePlantCapUnits" inputMode="numeric" />}
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-ui text-sm leading-none font-semibold text-cream">
              Takes effect
            </legend>

            <label className="flex items-center gap-3 font-ui text-sm text-cream">
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

            <label className="flex items-center gap-3 font-ui text-sm text-cream">
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

          {/*
            The confirmation step. Deliberately a manual toggle rather than a
            multi-page wizard: it puts the dangerous figures and the password on
            one screen, in view of each other, at the moment of the decision.
          */}
          <button
            type="button"
            onClick={() => setConfirming((value) => !value)}
            className="self-start rounded-md border-solid border-ink px-3 py-2 font-ui text-sm font-semibold text-cream [border-width:var(--outline-ink)]"
          >
            {confirming ? 'Hide confirmation' : 'Review before publishing'}
          </button>

          {confirming && (
            <div className="rounded-md border-solid border-ember bg-ink-800 p-4 [border-width:var(--outline-ink)]">
              <h3 className="mb-2 font-data text-xs tracking-widest text-ember uppercase">
                Confirm — these values become law for every checkout
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 font-ui text-sm text-cream">
                <li>
                  Class <span className="font-data text-white">{selected}</span>, measured
                  in <span className="font-data text-white">{spec?.unit}</span>
                </li>
                <li>
                  Replaces{' '}
                  {live ? (
                    <span className="font-data text-white">v{live.version}</span>
                  ) : (
                    <span className="text-flare">nothing — this class has no rule</span>
                  )}
                </li>
                <li>
                  Takes effect{' '}
                  <span className="font-data text-white">
                    {timing === 'now' ? 'immediately (server time, UTC)' : 'at the scheduled time (UTC)'}
                  </span>
                </li>
                <li>
                  A conversion of <span className="font-data text-white">0</span> would mean
                  this class counts toward no cap at all. Publication refuses it for
                  every class except immature plants and non-cannabis merchandise.
                </li>
                <li>The three caps are enforced independently — all must pass.</li>
              </ul>
            </div>
          )}

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
            <label htmlFor="acknowledgeImmutable" className="font-ui text-sm text-cream">
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
