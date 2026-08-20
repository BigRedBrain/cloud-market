'use client'

import { useMemo, useState } from 'react'

import { AuthForm } from '@/components/auth/auth-form'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea } from '@/components/ui/field'
import { Alert } from '@/components/ui/feedback'
import {
  bulkClassifyAction,
  classifyVariantAction,
} from '@/lib/catalog/compliance-actions'

/**
 * Catalog compliance workbench.
 *
 * The screen where a person states what a product physically is. Nothing here
 * suggests, pre-fills from a product name, or maps a category to a class —
 * every field starts empty and is typed by someone who can be asked to justify
 * it.
 *
 * The per-unit figures shown beside each variant come from the SERVER, computed
 * by the same code that will evaluate the limit at checkout. A preview that did
 * its own arithmetic in the browser would eventually disagree with the thing it
 * is previewing, and the disagreement would surface as a refused order.
 */

export type ComplianceRow = {
  variantId: string
  sku: string
  label: string
  productName: string
  active: boolean
  cannabisClass: string | null
  measurementBasis: string | null
  measurementValue: string | null
  measurementUnit: string | null
  usableEquivalentGrams: string | null
  concentrateGrams: string | null
  immaturePlantCount: number | null
  ready: boolean
  rejectionKind: string | null
  reason: string | null
}

export type MatrixEntry = {
  cannabisClass: string
  basis: string
  unit: string
  countsAsCannabis: boolean
  equivalence: string
  requiresValue: boolean
  wholeNumbersOnly: boolean
}

type Filter =
  | 'all'
  | 'ready'
  | 'not_ready'
  | 'other'
  | 'missing_measurement'
  | 'unsupported_basis'
  | 'zero_equivalent'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ready', label: 'Ready' },
  { key: 'not_ready', label: 'Not ready' },
  { key: 'other', label: '“other”' },
  { key: 'missing_measurement', label: 'Missing measurement' },
  { key: 'unsupported_basis', label: 'Unsupported basis' },
  { key: 'zero_equivalent', label: 'Zero-equivalent' },
]

function matches(row: ComplianceRow, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'ready':
      return row.ready
    case 'not_ready':
      return !row.ready
    case 'other':
      return row.cannabisClass === 'other' || row.cannabisClass === 'edible'
    case 'missing_measurement':
      return row.rejectionKind === 'value_required' || row.rejectionKind === 'basis_required'
    case 'unsupported_basis':
      return (
        row.rejectionKind === 'basis_mismatch' ||
        row.rejectionKind === 'unsupported_class' ||
        row.rejectionKind === 'value_not_allowed'
      )
    case 'zero_equivalent':
      return (
        row.rejectionKind === 'value_not_positive' ||
        row.rejectionKind === 'plants_not_whole' ||
        row.rejectionKind === 'value_not_decimal'
      )
  }
}

export function CatalogComplianceWorkbench({
  rows,
  matrix,
  classes,
}: {
  rows: ComplianceRow[]
  matrix: MatrixEntry[]
  classes: readonly string[]
}) {
  const [filter, setFilter] = useState<Filter>('not_ready')
  const [showInactive, setShowInactive] = useState(true)
  const [classFilter, setClassFilter] = useState<string>('any')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkClass, setBulkClass] = useState<string>(classes[0] ?? '')

  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          matches(row, filter) &&
          (showInactive || row.active) &&
          (classFilter === 'any' || (row.cannabisClass ?? 'null') === classFilter),
      ),
    [rows, filter, showInactive, classFilter],
  )

  const bulkSpec = matrix.find((m) => m.cannabisClass === bulkClass)
  const readyCount = rows.filter((r) => r.ready).length
  const activeBlocked = rows.filter((r) => !r.ready && r.active).length

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Variants" value={String(rows.length)} />
        <Stat label="Checkout ready" value={`${readyCount} / ${rows.length}`} />
        <Stat
          label="Active and blocked"
          value={String(activeBlocked)}
          tone={activeBlocked > 0 ? 'flare' : 'volt'}
        />
      </div>

      {activeBlocked > 0 && (
        <Alert tone="warning" title="Active variants that cannot be sold">
          {activeBlocked} variant{activeBlocked === 1 ? '' : 's'} are customer-visible
          and will be refused at the bag and at checkout. They stay listed here
          until classified — nothing is rewritten automatically.
        </Alert>
      )}

      {/* ---------------------------------------------------------- matrix */}
      <details className="rounded-md border-solid border-ink bg-ink-800 p-4 [border-width:var(--outline-ink)]">
        <summary className="cursor-pointer font-data text-xs tracking-widest text-smoke uppercase">
          The classification matrix
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse font-data text-xs">
            <thead>
              <tr className="border-b-2 border-ink text-left text-smoke">
                <th className="py-2 pr-4 font-normal">Class</th>
                <th className="py-2 pr-4 font-normal">Measured as</th>
                <th className="py-2 pr-4 font-normal">Unit</th>
                <th className="py-2 pr-4 font-normal">Conversion</th>
                <th className="py-2 font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((entry) => (
                <tr key={entry.cannabisClass} className="border-b border-ink-600 text-white">
                  <td className="py-2 pr-4">{entry.cannabisClass}</td>
                  <td className="py-2 pr-4">{entry.basis.replace(/_/g, ' ')}</td>
                  <td className="py-2 pr-4">{entry.unit}</td>
                  <td className="py-2 pr-4">{entry.equivalence}</td>
                  <td className="py-2">
                    {entry.requiresValue
                      ? entry.wholeNumbersOnly
                        ? 'positive whole number'
                        : 'positive'
                      : 'must be empty'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* --------------------------------------------------------- filters */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`rounded-md border-solid border-ink px-3 py-1.5 font-ui text-sm font-semibold [border-width:var(--outline-ink)] ${
                filter === f.key ? 'bg-ember text-ink' : 'text-cream'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 font-ui text-sm text-cream">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="size-4"
            />
            Include inactive
          </label>

          <label className="flex items-center gap-2 font-ui text-sm text-cream">
            Class
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="h-9 rounded-md border-solid border-ink bg-ink-700 px-2 font-data text-xs text-cream [border-width:var(--outline-ink)]"
            >
              <option value="any">any</option>
              <option value="null">unclassified</option>
              {[...classes, 'other', 'edible'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <span className="font-data text-xs text-smoke">
            {visible.length} shown · {selected.size} selected
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------ bulk */}
      {selected.size > 0 && (
        <div className="rounded-md border-solid border-ember bg-ink-800 p-4 [border-width:var(--outline-ink)]">
          <h3 className="mb-3 font-data text-xs tracking-widest text-ember uppercase">
            Classify {selected.size} selected variant{selected.size === 1 ? '' : 's'}
          </h3>
          <p className="mb-4 font-ui text-sm text-smoke">
            One class, one measurement, applied to every selected SKU. Only use
            this where the same value genuinely applies to all of them — a
            two-gram and a three-and-a-half-gram jar are not the same
            measurement, however similar the products look.
          </p>

          <AuthForm
            action={bulkClassifyAction}
            submitLabel={`Apply to ${selected.size} variant${selected.size === 1 ? '' : 's'}`}
            pendingLabel="Applying"
            successMessage="Applied. Every change was audited; reload to see the new state."
          >
            {(fieldErrors) => (
              <>
                {[...selected].map((id) => (
                  <input key={id} type="hidden" name="variantIds" value={id} />
                ))}

                <div className="max-h-48 overflow-y-auto rounded-md border-solid border-ink bg-ink-900 p-3 [border-width:var(--outline-ink)]">
                  <table className="w-full border-collapse font-data text-xs">
                    <tbody>
                      {rows
                        .filter((r) => selected.has(r.variantId))
                        .map((r) => (
                          <tr key={r.variantId} className="border-b border-ink-600">
                            <td className="py-1 pr-3 text-white">{r.sku}</td>
                            <td className="py-1 pr-3 text-smoke">
                              {r.cannabisClass ?? 'null'}/{r.measurementBasis ?? 'null'}/
                              {r.measurementValue ?? 'null'}
                            </td>
                            <td className="py-1 text-volt">
                              → {bulkClass}/{bulkSpec?.basis ?? '?'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                <Field
                  id="bulkClass"
                  label="Classification"
                  error={fieldErrors?.cannabisClass?.[0]}
                  hint={
                    bulkSpec
                      ? `Measured as ${bulkSpec.basis.replace(/_/g, ' ')} in ${bulkSpec.unit}. ${bulkSpec.requiresValue ? 'A positive value is required.' : 'No value permitted.'}`
                      : undefined
                  }
                  required
                >
                  {(props) => (
                    <select
                      {...props}
                      name="cannabisClass"
                      value={bulkClass}
                      onChange={(e) => setBulkClass(e.target.value)}
                      className="h-11 w-full rounded-md border-solid border-ink bg-ink-700 px-3 font-ui text-base text-cream [border-width:var(--outline-ink)]"
                    >
                      {classes.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field
                  id="bulkValue"
                  label={`Measurement value${bulkSpec ? ` (${bulkSpec.unit})` : ''}`}
                  error={fieldErrors?.measurementValue?.[0]}
                  hint={
                    bulkSpec?.requiresValue
                      ? 'Exact decimal. Leave empty only for non-cannabis merchandise.'
                      : 'Must be empty for this class.'
                  }
                >
                  {(props) => <Input {...props} name="measurementValue" inputMode="decimal" />}
                </Field>

                <Field
                  id="bulkReason"
                  label="Reason"
                  error={fieldErrors?.reason?.[0]}
                  hint="At least 15 characters. Recorded against every variant in the batch."
                  required
                >
                  {(props) => <Textarea {...props} name="reason" rows={2} />}
                </Field>
              </>
            )}
          </AuthForm>
        </div>
      )}

      {/* ----------------------------------------------------------- table */}
      <div className="flex flex-col gap-3">
        {visible.length === 0 && (
          <p className="text-sm text-smoke">No variants match this filter.</p>
        )}

        {visible.map((row) => (
          <VariantCard
            key={row.variantId}
            row={row}
            matrix={matrix}
            classes={classes}
            selected={selected.has(row.variantId)}
            onToggle={() => toggle(row.variantId)}
          />
        ))}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'cream',
}: {
  label: string
  value: string
  tone?: 'cream' | 'volt' | 'flare'
}) {
  return (
    <div className="rounded-md border-solid border-ink bg-ink-800 p-4 [border-width:var(--outline-ink)]">
      <div className="font-data text-xs tracking-widest text-smoke uppercase">{label}</div>
      <div
        className={`mt-1 font-data text-xl ${
          tone === 'flare' ? 'text-flare' : tone === 'volt' ? 'text-volt' : 'text-white'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * One variant, with its classification form ALWAYS RENDERED.
 *
 * Not behind an expand toggle, for two reasons. It is a workbench — the form is
 * the reason the row is on the screen — and a form that only exists after a
 * client-side click does not exist in the server-rendered HTML at all, so the
 * page stops working without JavaScript and the HTTP verification suite has no
 * form to post. Both are the same defect seen from different sides.
 */
function VariantCard({
  row,
  matrix,
  classes,
  selected,
  onToggle,
}: {
  row: ComplianceRow
  matrix: MatrixEntry[]
  classes: readonly string[]
  selected: boolean
  onToggle: () => void
}) {
  const [chosen, setChosen] = useState<string>(row.cannabisClass ?? classes[0] ?? '')
  const spec = matrix.find((m) => m.cannabisClass === chosen)

  return (
    <div className="rounded-md border-solid border-ink bg-ink-800 [border-width:var(--outline-ink)]">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.sku}`}
          className="mt-1 size-4 shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-ui text-sm font-semibold text-white">
              {row.productName}
            </span>
            <span className="font-data text-xs text-smoke">{row.label}</span>
            <span className="font-data text-xs text-smoke">{row.sku}</span>
            <Badge variant={row.ready ? 'volt' : 'flare'}>
              {row.ready ? 'Ready' : 'Not ready'}
            </Badge>
            <Badge variant={row.active ? 'ember' : 'outline'}>
              {row.active ? 'Active' : 'Inactive'}
            </Badge>
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-data text-xs sm:grid-cols-3">
            <Pair label="class" value={row.cannabisClass ?? '—'} />
            <Pair label="basis" value={row.measurementBasis?.replace(/_/g, ' ') ?? '—'} />
            <Pair
              label="measurement"
              value={
                row.measurementValue
                  ? `${row.measurementValue} ${row.measurementUnit ?? ''}`.trim()
                  : '—'
              }
            />
            <Pair label="usable equiv." value={row.usableEquivalentGrams ?? '—'} />
            <Pair label="concentrate" value={row.concentrateGrams ?? '—'} />
            <Pair
              label="plants"
              value={row.immaturePlantCount === null ? '—' : String(row.immaturePlantCount)}
            />
          </dl>

          {row.reason && (
            <p role="status" className="mt-2 font-ui text-sm text-flare">
              {row.reason}
            </p>
          )}
        </div>

      </div>

      <div className="border-t-2 border-ink p-4">
          <AuthForm
            action={classifyVariantAction}
            submitLabel="Save classification"
            pendingLabel="Saving"
            successMessage="Saved and audited. Reload to see the updated readiness."
          >
            {(fieldErrors) => (
              <>
                <input type="hidden" name="variantId" value={row.variantId} />

                <Field
                  id={`class-${row.variantId}`}
                  label="Classification"
                  error={fieldErrors?.cannabisClass?.[0]}
                  hint={
                    spec
                      ? `Measured as ${spec.basis.replace(/_/g, ' ')} in ${spec.unit}. Conversion ${spec.equivalence}.`
                      : undefined
                  }
                  required
                >
                  {(props) => (
                    <select
                      {...props}
                      name="cannabisClass"
                      value={chosen}
                      onChange={(e) => setChosen(e.target.value)}
                      className="h-11 w-full rounded-md border-solid border-ink bg-ink-700 px-3 font-ui text-base text-cream [border-width:var(--outline-ink)]"
                    >
                      {classes.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <Field
                  id={`value-${row.variantId}`}
                  label={`Measurement value${spec ? ` (${spec.unit})` : ''}`}
                  error={fieldErrors?.measurementValue?.[0]}
                  hint={
                    spec?.requiresValue
                      ? spec.wholeNumbersOnly
                        ? 'A positive whole number of plants.'
                        : 'Exact decimal, greater than zero. This is the authoritative compliance measurement, not the label weight.'
                      : 'Must be empty — non-cannabis merchandise is exempt.'
                  }
                >
                  {(props) => <Input {...props} name="measurementValue" inputMode="decimal" />}
                </Field>

                <Field
                  id={`reason-${row.variantId}`}
                  label="Reason"
                  error={fieldErrors?.reason?.[0]}
                  hint="At least 15 characters. This is the audit record."
                  required
                >
                  {(props) => <Textarea {...props} name="reason" rows={2} />}
                </Field>
              </>
            )}
          </AuthForm>
      </div>
    </div>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-smoke">{label} </dt>
      <dd className="inline text-white">{value}</dd>
    </div>
  )
}
