'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Minus, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import {
  addToBagAction,
  removeFromBagAction,
  updateBagQuantityAction,
} from '@/lib/bag/actions'
import type { ActionResult } from '@/lib/result'

/**
 * Bag controls.
 *
 * Every control is a real `<form>` posting a Server Action, so **the entire bag
 * works with JavaScript disabled** — add, increment, decrement and remove are
 * all plain form submissions. `useActionState` layers inline feedback on top
 * when hydrated; it is an enhancement, not a requirement.
 *
 * The forms carry only a variant id, a line id and a quantity. No price, no
 * stock figure — there is nothing here a tampered payload could use to shift a
 * total, because totals are computed server-side from the catalog.
 */

function Pending({ children, label }: { children: React.ReactNode; label: string }) {
  const { pending } = useFormStatus()
  return (
    <span aria-live="polite">
      {pending ? <span className="sr-only">{label}</span> : null}
      {children}
    </span>
  )
}

/** Add to bag. Used on product detail; quantity defaults to 1. */
export function AddToBagForm({
  variantId,
  label,
  disabled,
  soldOut,
}: {
  variantId: string
  label: string
  disabled?: boolean
  soldOut?: boolean
}) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    addToBagAction,
    null,
  )

  return (
    <div className="flex flex-col gap-2">
      {state && !state.ok && (
        <Alert tone="warning" title="Check availability">
          {state.message}
        </Alert>
      )}
      {state && state.ok && (
        <Alert tone="success" title="Added to your bag">
          {label} is in your bag.
        </Alert>
      )}
      <form action={action}>
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="quantity" value="1" />
        <Button
          type="submit"
          variant={soldOut ? 'outline' : 'primary'}
          disabled={disabled || soldOut}
          className="w-full"
        >
          {soldOut ? 'Sold out' : `Add ${label}`}
        </Button>
      </form>
    </div>
  )
}

/**
 * Quantity stepper.
 *
 * Two separate single-purpose forms rather than a number input plus an "update"
 * button. Each press is one atomic server round trip, which means a stepper
 * cannot get out of sync with the server, and it needs no client state at all.
 * The accessible name says what it does *to what* — "Decrease quantity of
 * Midnight Runtz 3.5g" — rather than a bare "minus".
 */
export function QuantityStepper({
  lineId,
  quantity,
  maxQuantity,
  itemName,
}: {
  lineId: string
  quantity: number
  maxQuantity: number
  itemName: string
}) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    updateBagQuantityAction,
    null,
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <form action={action}>
          <input type="hidden" name="lineId" value={lineId} />
          <input type="hidden" name="quantity" value={Math.max(1, quantity - 1)} />
          <Button
            type="submit"
            variant="outline"
            size="icon"
            disabled={quantity <= 1}
            aria-label={`Decrease quantity of ${itemName}`}
          >
            <Pending label="Updating">
              <Minus aria-hidden="true" />
            </Pending>
          </Button>
        </form>

        <span
          className="min-w-10 text-center font-mono text-base font-bold text-white"
          aria-label={`Quantity: ${quantity}`}
        >
          {quantity}
        </span>

        <form action={action}>
          <input type="hidden" name="lineId" value={lineId} />
          <input type="hidden" name="quantity" value={quantity + 1} />
          <Button
            type="submit"
            variant="outline"
            size="icon"
            disabled={quantity >= maxQuantity}
            aria-label={`Increase quantity of ${itemName}`}
          >
            <Pending label="Updating">
              <Plus aria-hidden="true" />
            </Pending>
          </Button>
        </form>
      </div>

      {state && !state.ok && (
        <p role="status" className="font-sans text-xs text-ember">
          {state.message}
        </p>
      )}
    </div>
  )
}

export function RemoveLineForm({
  lineId,
  itemName,
}: {
  lineId: string
  itemName: string
}) {
  const [state, action] = useActionState<ActionResult<void> | null, FormData>(
    removeFromBagAction,
    null,
  )

  return (
    <form action={action}>
      <input type="hidden" name="lineId" value={lineId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        aria-label={`Remove ${itemName} from your bag`}
      >
        <Trash2 aria-hidden="true" />
        Remove
      </Button>
      {state && !state.ok && (
        <p role="status" className="mt-1 font-sans text-xs text-flare">
          {state.message}
        </p>
      )}
    </form>
  )
}
