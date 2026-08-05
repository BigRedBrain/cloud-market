'use client'

import { useState } from 'react'

import { AuthForm } from '@/components/auth/auth-form'
import { Field } from '@/components/ui/field'
import {
  cancelOrderAction,
  placeOrderAction,
  startCheckoutAction,
} from '@/lib/orders/actions'

/**
 * Places the order.
 *
 * THE IDEMPOTENCY KEY IS GENERATED ONCE, when the form first mounts, and travels
 * in a hidden field. A double-clicked button, a resubmitted form and a refreshed
 * POST all carry the same key, so the second attempt finds the order the first
 * one created instead of creating another.
 *
 * Generating it per render would defeat the point entirely — every retry would
 * look like a fresh checkout. `useState` with an initialiser gives one value for
 * the lifetime of the mounted form.
 *
 * It is not a secret and cannot be abused: the worst a chosen key can do is
 * collide with the sender's own earlier order, which is precisely the behaviour
 * it exists to produce.
 */
export function PlaceOrderForm({ orderId }: { orderId: string }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  return (
    <AuthForm
      action={placeOrderAction}
      submitLabel="Place order"
      pendingLabel="Placing your order"
    >
      {(errors) => (
        <>
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

          <Field
            id="ageConfirmed"
            label="I am 21 or older and will bring photo ID"
            error={errors?.ageConfirmed?.[0]}
            required
          >
            {(props) => (
              <input
                type="checkbox"
                name="ageConfirmed"
                className="size-5 rounded border-2 border-ink accent-ember"
                {...props}
              />
            )}
          </Field>

          <p className="text-xs text-smoke">
            Payment is cash at pickup. Placing the order holds your items; we
            check ID before handing them over.
          </p>
        </>
      )}
    </AuthForm>
  )
}

/** Cancels a placed order. Safe to submit twice — the action is idempotent. */
export function CancelOrderForm({ orderId }: { orderId: string }) {
  return (
    <AuthForm
      action={cancelOrderAction}
      submitLabel="Cancel this order"
      pendingLabel="Cancelling"
    >
      {() => <input type="hidden" name="orderId" value={orderId} />}
    </AuthForm>
  )
}

/**
 * Starts checkout from the bag.
 *
 * Disabled when the bag has unavailable lines: the draft would fail on those
 * items anyway, and refusing here is a clearer answer than an error after the
 * click. The server re-checks regardless — this is convenience, not a guard.
 */
export function StartCheckoutForm({ disabled }: { disabled?: boolean }) {
  /**
   * Uses `AuthForm` rather than a bare form so a refusal is visible. "Someone
   * else took the last of an item in your bag" is the message that matters most
   * here, and a plain form action returning a result would have nowhere to show
   * it.
   */
  return (
    <AuthForm
      action={startCheckoutAction}
      submitLabel={disabled ? 'Resolve items above to check out' : 'Checkout'}
      pendingLabel="Starting checkout"
      disabled={disabled}
    >
      {() => null}
    </AuthForm>
  )
}
