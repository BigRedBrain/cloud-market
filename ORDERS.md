# Checkout & Orders (Phase 4)

Branch `feat/checkout-orders`. Development only — migration 0008 is applied to
the development branch; production remains on 0007. **No production catalog data
was created.**

---

## 1. Schema — migration 0008

Additive. Nothing existing is rewritten.

| Change | Detail |
| --- | --- |
| 6 new tables | `orders`, `order_lines`, `order_events`, `payments`, `fulfilments`, `purchase_limit_rules` |
| 8 new enums | `order_status`, `order_event_type`, `order_actor_type`, `fulfilment_type`, `payment_method`, `payment_status`, `inventory_state`, `cannabis_class` |
| 2 new columns on `product_variants` | `reserved_quantity`, `cannabis_class` |
| 10 new `audit_event` values | order, payment, inventory and compliance events |

**One-way:** the `audit_event` additions cannot be reversed, same as 0006/0007.

### The defining decision, inverted

`cart_lines` hold a variant id and a quantity because a cart line is a
**pointer** — "whatever this costs now". `order_lines` copy the SKU, product
name, variant label, category, brand, unit price, per-line tax, weight, THC/CBD,
cannabis class and the limit factor applied, because an order line is a
**record** — "this is what was sold, at this price, on this date".

Both follow one principle: *store a fact where it is a fact, and a reference
where it is a reference.* A renamed product or a repriced variant must not change
what an order says was sold.

---

## 2. Inventory

```
available = inventory_quantity - reserved_quantity
```

| Event | `inventory_quantity` | `reserved_quantity` |
| --- | --- | --- |
| Draft created | — | **+qty** |
| Draft expires / abandoned | — | −qty |
| **Order placed** | **−qty** | −qty |
| Order cancelled | **+qty** | — |
| Order completed | — | — |

**Two counters, not one.** With a single number an expired draft and a completed
sale are indistinguishable afterwards, and there is no way to know whether stock
should come back.

**Committed at placement, not at payment.** Payment is cash at handoff; waiting
for it would leave a promised order's stock merely held, able to expire while the
customer drives over.

**Every move is one conditional statement.** The check lives inside the write:

```sql
UPDATE product_variants
   SET reserved_quantity = reserved_quantity + $qty
 WHERE id = $variant
   AND inventory_quantity - reserved_quantity >= $qty
```

No row returned means someone else took the last unit — and the customer is told
before entering any details.

**Every move is idempotent**, guarded by `orders.inventory_state`
(`reserved → committed → released`). Each transition is a conditional UPDATE that
exactly one caller wins; retries are no-ops, not errors.

**Database time only.** Every expiry comparison evaluates `now()` inside
Postgres — including the one on the review page, where an earlier draft used
`Date.now()` and the linter was right to reject it.

---

## 3. Order state and events

```
draft ──► placed ──► preparing ──► ready ──► completed
  │          │           │           │
  │          └───────────┴───────────┴──► cancelled
  └──► expired
```

`order_events` is **append-only**. `orders.current_status` is a projection of it,
written in the same transaction by the single function `recordTransition`.
Nothing else is permitted to set the status, so a status can never exist with no
history behind it. If the two ever disagree, the event log wins — it is the one
that answers "who cancelled this, and when".

Event types are an enum, never free-form strings. Every event records
`actor_type` (`customer` / `staff` / `system`) and `actor_id` where one exists.

---

## 4. Idempotency

| Operation | Mechanism |
| --- | --- |
| Placement | Client-generated key + `UNIQUE (user_id, idempotency_key)`, plus a conditional claim on `current_status = 'draft'` |
| Expiry | Conditional UPDATE on `status='draft' AND reserved_until <= now()` |
| Cancellation | Conditional UPDATE on a non-terminal status; a repeat reports `alreadyCancelled` |
| Payment collection | Partial unique index allows one `awaiting_collection` payment per order; collection is a conditional UPDATE |
| Inventory | `claimInventoryTransition` — one winner per transition |

The key is generated **once when the form mounts** (`useState` with an
initialiser), not per render. Generating it per render would make every retry
look like a fresh checkout, which is the opposite of the intent.

---

## 5. Money

Integer cents throughout; **no float ever holds money**. Rates are basis points.

**Tax is computed per line and summed** — never computed on the order total and
divided back. Those two disagree whenever rounding lands differently, and when
they disagree it is the receipt that is wrong. The property tests measure this:
per-line and whole-order excise diverge in **917 of 2000** random baskets.

Sales tax applies to subtotal **plus** excise, which is the Michigan ordering.
Getting it the other way round understates the bill by 0.6%.

`roundHalfAwayFromZero` rather than `Math.round`, because `Math.round` treats
−0.5 and 0.5 differently — irrelevant while everything is positive, wrong the
moment a refund exists.

Every order snapshots the **rates applied**, so a historical order reproduces
exactly after a rate change.

---

## 6. Purchase limits

Configuration, not constants. `purchase_limit_rules` holds one row per cannabis
class with an equivalence factor and daily caps, versioned by effective date.
Checkout code contains no gram figures.

Each order line snapshots `equivalent_grams`, `concentrate_grams`,
`equivalent_factor_applied` and `purchase_limit_rule_id`, so a check can be
reproduced after the rules change — the factor says what arithmetic was done,
the rule id says on whose authority.

Enforced at **both** draft creation and placement. A failure at placement rolls
back completely: no placed order, and the hold is left for the customer to fix
their basket rather than stranded.

"Today" is a **rolling 24 hours**, not a calendar day — a calendar boundary lets
someone buy the maximum at 23:55 and again at 00:05.

**The default numbers need legal confirmation.** Michigan adult-use is commonly
stated as 2.5 oz (70.87 g) per day with no more than 15 g concentrate; edible
equivalence varies by interpretation. That is exactly why they are data.

Rules are **immutable and versioned**, published through an admin screen gated
on a named `compliance_admin` grant, with re-authentication and a full audit
trail. See [PURCHASE-LIMITS.md](PURCHASE-LIMITS.md).

### Seeding

```bash
npm run db:seed:limits              # report only, writes nothing
npm run db:seed:limits -- --confirm
```

The script prints the target endpoint fingerprint before doing anything, so it
can be compared against the migration gate by eye. It only ever **inserts**: a
live rule with different numbers stops the run rather than being overwritten,
because a historical order must stay re-checkable against the rule that applied
when it was placed. `--supersede` closes the old row (`effective_until = now()`)
and opens a new one in the same transaction — a correction with a paper trail.
Rerunning with nothing to change does nothing.

Applied to development; the four classes are live there. Production has no rules
yet and must not get them until the values are confirmed.

---

## 7. Age

- Date of birth is collected at sign-up and checked 21+ there.
- Re-affirmed by the customer at placement (a required checkbox) and snapshotted
  to `date_of_birth_at_purchase`.
- **Government photo ID is checked by staff at handoff.** `collectPaymentAndComplete`
  refuses without `idChecked`, and records `AGE_VERIFIED_AT_HANDOFF`.

The stored date of birth is a **claim the customer typed**. The physical check is
the one that satisfies the licence, and the code treats them differently.

---

## 8. Payment

Cash at handoff. `payments` is provider-neutral: method, status, amount,
`processor_reference`, `failure_code`, `collected_at`, `collected_by`.

Recorded `awaiting_collection` at placement; `collected` at pickup. A partial
unique index permits one open obligation per order, so a retried placement cannot
create a second. Failed and refunded rows accumulate freely — that history is why
this is a table rather than a status column, and it is what an ACH integration
will need.

**No processor is integrated.** Cannabis is federally illegal; Stripe and the
card networks prohibit it, and integrating one would end in account termination.

---

## 9. Fulfilment

Pickup only. `fulfilments` records the store, handoff time, who handed off and
whether ID was checked.

Delivery columns are **absent, not present-and-unused**. An address column nobody
writes is an invitation to write to it, and delivery carries municipal rules,
radius checks and driver records that belong to their own phase.
`fulfilment_type` is the seam.

---

## 10. Test results

```
npm run test:math          29 passed, 0 failed   (~40,000 generated cases)
npm run test:concurrency   28 passed, 0 failed   (real database, real races)
npm run test:recovery     155 passed, 0 failed   (regression)
npm run test:e2e           94 passed, 0 failed   (regression)
npm run test:bag           63 passed, 0 failed   (regression)
npm run test:browser       26 passed, 0 failed   (regression)
npm run test:auth          28 passed, 0 failed   (regression)
npm run test:email         12 passed, 0 failed   (regression)
lint / typecheck / build   clean
```

### Property-based (`test:math`)

Rounding is integral, bounded by half a unit, and symmetric about zero. Line
subtotal is exactly price × quantity; doubling quantity doubles subtotal. Tax is
non-negative, never exceeds the amount below 100%, is monotonic, and is zero at a
zero rate. Line total is exactly subtotal + both taxes. Order tax equals the sum
of line tax; order total equals the sum of line totals; line order does not
change the result. Limits scale linearly, weightless items never count, only
concentrate counts toward the concentrate cap, exactly at the cap is allowed and
one milligram over is refused.

### Concurrency (`test:concurrency`)

| Race | Result |
| --- | --- |
| Two customers, one unit | exactly one draft wins; the loser is told stock ran out |
| Two placements at once | one succeeds; stock moves once; one `ORDER_PLACED` event |
| Duplicate key placement | retry reports success, flagged `alreadyPlaced`; one order, one payment |
| Expiry racing placement | placed **or** expired, never both; no stock left held either way |
| Duplicate cancellation | restocks once; one `ORDER_CANCELLED` event; simultaneous cancels also restock once |

Plus: `current_status` matches the latest event for every order, and every
fixture is removed by exact id.

---

## 11. Known limitations

1. **No production verification yet** — production has no catalog. See §12.
2. **The expiry sweep has no scheduler.** `sweepExpiredDrafts()` exists and is
   tested; nothing calls it periodically. A cron entry or a Vercel scheduled
   function is a follow-up. Until then an abandoned draft holds stock until
   someone runs it — which is why the TTL is short.
3. **Purchase limit values need legal confirmation** (§6). Development is
   seeded; production deliberately is not.
4. **Single store.** The draft picks the first pickup-enabled store. Multi-store
   selection is a UI and inventory question, deliberately out of scope.
5. **No staff UI.** `collectPaymentAndComplete` is implemented and tested but has
   no screen — staff order management is its own phase.
6. **Excise applies to all sales.** Medical exemption needs a `sale_type`, which
   the schema does not yet carry.

---

## 12. Production verification checklist

**Cannot run until real licensed store, product and inventory data exists.** No
fake catalog data may be created in production — same rule as Phase 3.

### Prerequisites

- [ ] At least one `stores` row with `pickup_enabled = true`, a real licence
      number and a real address
- [ ] Real products and variants with correct `price_cents`, `weight_grams` and
      `cannabis_class`
- [ ] Real `inventory_quantity`, with `reserved_quantity` at 0
- [ ] `purchase_limit_rules` populated with **legally confirmed** values, via
      `npm run db:seed:limits` (report first, then `-- --confirm`), after
      editing `RULES` in the script to whatever counsel confirms
- [ ] All four cannabis classes have a live rule — a class with none gets a
      factor of 0 and counts toward nothing
- [ ] Migration 0008 applied via the gated sequence
      (`verify-migration-target.mjs` → `GO` → `drizzle-kit migrate` → confirm)

### Schema

- [ ] Journal at 9 entries
- [ ] All 6 tables present; `reserved_quantity` and `cannabis_class` on variants
- [ ] All 10 audit enum values present
- [ ] No existing row altered by the migration

### Flow, with a controlled account

- [ ] Add to bag → Checkout → draft created, `reserved_quantity` increments
- [ ] Review shows correct subtotal, excise, sales tax and total
- [ ] Totals match `test:math` for the same inputs
- [ ] Place order → status `placed`, `inventory_quantity` decrements,
      `reserved_quantity` returns to prior value
- [ ] `payments` row is `awaiting_collection` for the exact total
- [ ] Order page shows the event history
- [ ] Double-submitting placement creates exactly one order
- [ ] Cancel → stock returns, payment `cancelled`, one `ORDER_CANCELLED` event
- [ ] Cancel again → reports success, stock unchanged

### Compliance

- [ ] A basket over the daily limit is refused, with `PURCHASE_LIMIT_BLOCKED`
      audited and **no order created and no stock left held**
- [ ] An unverified account cannot reach checkout
- [ ] Age checkbox is required
- [ ] `date_of_birth_at_purchase` snapshotted

### Expiry

- [ ] A draft left past 15 minutes shows the timeout on review
- [ ] `sweepExpiredDrafts()` releases it; `reserved_quantity` returns to prior
- [ ] A placement attempt after expiry is refused

### Cleanup

- [ ] Every created row removed **by captured id**
- [ ] Inventory back to its starting values
- [ ] Pre-existing audit rows all survive
- [ ] Every monitored table back to baseline
