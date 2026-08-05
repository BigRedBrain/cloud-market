# Phase 4 — Checkout & Orders

**Architecture proposal. Nothing implemented.** For review before any code is
written.

---

## 0. What already exists, and what it commits us to

| Already built | Consequence for Phase 4 |
| --- | --- |
| `cart_lines` = `variant_id` + `quantity`, **no price column** | The order boundary is where price becomes a promise. Every snapshot decision below follows from this. |
| Inventory validated, never reserved (`CART.md` §5) | Two customers can hold the last unit. Phase 4 has to decide when that stops being true. |
| `requireVerifiedUser()` exists and is unused | The gate is written; checkout is the first caller. |
| `stores` with `delivery_enabled`, `pickup_enabled`, `delivery_radius_meters`, geocoded origin | Fulfilment groundwork is laid. No `store_id` on carts yet. |
| `product_variants.weight_grams`, `thc_percent`, `cbd_percent`, `sku` | The fields a compliance report needs already exist per variant. |
| Money is integer cents; potency is `numeric` | Keep both. Never a float, anywhere near a total. |
| Audit log, one-way enum additions | Order events are audit events. Adding them is additive and irreversible. |
| No purchase-limit model (`CART.md` §10, deliberate) | Phase 4 is where this lands, and it is a legal requirement, not a product nicety. |

---

## 1. The three things that make this phase different

Everything before this was reversible. A cart can be wrong and nobody is harmed.
Three properties change that here, and they drive most of the design.

**Money.** Once a customer is charged, a mistake costs someone real money and
cannot be fixed by a redeploy.

**Regulation.** Michigan adult-use retail is licensed. Exceeding a daily purchase
limit, selling to an unverified 21+, or failing to report a sale is a licence
problem, not a bug. The state's seed-to-sale system (METRC) expects every sale
recorded.

**Physical goods.** An order is a promise about an object that must exist, be
picked, and be handed to a specific person. Inventory stops being advisory.

---

## 2. Schema

Five new tables. All additive; nothing existing is rewritten.

```
orders ──< order_lines >── product_variants
  │
  ├──< order_events          (append-only state history)
  ├──< payments              (attempts, not a single status column)
  └──  fulfilments           (pickup or delivery, one per order)
```

### `orders`

| Column | Purpose |
| --- | --- |
| `id`, `order_number` | UUID pk; a short human-readable number for support and the customer |
| `user_id` | `restrict`, **not** cascade — an order must outlive account deletion |
| `store_id` | Which licensed location fulfils it |
| `status` | See §3 |
| `fulfilment_type` | `pickup` \| `delivery` |
| `subtotal_cents`, `excise_tax_cents`, `sales_tax_cents`, `delivery_fee_cents`, `discount_cents`, `total_cents` | **Snapshots.** Every component stored separately, never recomputed |
| `customer_email`, `customer_name`, `customer_phone` | Snapshots — the order records who bought it, not who the account is now |
| `date_of_birth_at_purchase`, `age_verified_at`, `age_verified_by` | The compliance record |
| `placed_at`, `cancelled_at`, `completed_at` | Lifecycle timestamps, explicit, same reasoning as `carts` |

### `order_lines`

Everything the catalog knows at purchase time is **copied**:
`variant_id` (`restrict`), `sku`, `product_name`, `variant_label`,
`unit_price_cents`, `quantity`, `line_total_cents`, `weight_grams`,
`thc_percent`, `cbd_percent`, `strain_type`, `category_name`.

**Why copy so much.** A cart line is a pointer; an order line is a record. If a
product is renamed, repriced, or retired, the order must still say what was
actually sold — for the customer's receipt, for a refund, and for a regulator
asking what left the building. This is the exact inverse of the cart's
no-price rule, and both follow from the same principle: *store a fact where it
is a fact, and a reference where it is a reference.*

### `order_events` — append-only

`order_id`, `from_status`, `to_status`, `actor_type` (`customer` \| `staff` \|
`system`), `actor_id`, `reason`, `occurred_at`.

Never updated, never deleted. "Who cancelled this and when" is a question that
gets asked precisely when someone is unhappy, and a mutable `status` column
cannot answer it.

### `payments`

`order_id`, `method`, `status`, `amount_cents`, `processor_reference`,
`attempted_at`, `settled_at`, `failure_code`.

**A table, not a column.** Payments retry. A single `payment_status` on `orders`
would lose the first failure, and "the customer says their card was declined
twice" needs to be answerable.

### `fulfilments`

`order_id`, `type`, `store_id`, `address_line1/2`, `city`, `state`, `postal_code`,
`latitude`, `longitude`, `delivery_window_start/end`, `handed_off_at`,
`handed_off_by`, `recipient_id_checked`, `signature_ref`.

---

## 3. Order state machine

```
                 ┌──────────────► cancelled
                 │                    ▲
draft ──► pending_payment ──► paid ──►┤
                 │                    ├──► preparing ──► ready ──┐
                 └──► payment_failed  │                          ├──► completed
                                      └──► out_for_delivery ─────┘
                                                   │
                                                   └──► returned
```

**Every transition writes an `order_events` row.** Statuses are a projection of
that history, not the source of truth.

**`draft` exists so checkout is resumable.** A customer who closes the tab at the
address step should not lose their work, and a draft order is also where the
inventory hold lives (§4).

**Cancellation is terminal and explicit.** No status is ever silently rewound.

---

## 4. Inventory reservation — the central decision

Phase 3 deliberately reserved nothing. Phase 4 must, and the question is
*when*.

**Proposal: reserve at `draft` creation, with a short TTL; commit at `paid`;
release on expiry or cancellation.**

```sql
-- one statement, the check and the write together
UPDATE product_variants
   SET inventory_quantity = inventory_quantity - $qty
 WHERE id = $variant AND inventory_quantity >= $qty
RETURNING inventory_quantity
```

No row returned means somebody else took the last unit, and the customer is told
before they enter an address — not after they pay.

**Why a TTL.** Reservations that never expire let an abandoned checkout hold
stock indefinitely. A 15-minute hold released by a sweep is the smallest thing
that works. `reserved_until` on the order; a scheduled job releases expired
holds by adding the quantity back.

**Why not reserve at add-to-bag.** A bag is browsing. Reserving there means one
person with an open tab denies stock to everyone, and it is exactly the
"reserved for you" promise Phase 3 refused to make.

**The honest trade:** a reservation system has a failure mode where stock is held
by orders that never complete. That is recoverable (the sweep). The alternative
— overselling a regulated product that must physically exist — is not.

---

## 5. Payment — the constraint to decide first

**This is the item most likely to change the plan, so it should be settled before
any code.**

Cannabis is federally illegal in the US. Visa, Mastercard and most processors
prohibit it, and Stripe explicitly does. A dispensary storefront cannot simply
integrate Stripe Checkout.

| Option | Reality |
| --- | --- |
| **Cash on delivery / at pickup** ✅ | What most Michigan dispensaries actually do. No processor, no chargebacks, no PCI scope. Requires cash handling and a "record payment" step for staff. |
| **PIN debit / cashless ATM** | Common in dispensaries; legally contested and periodically shut down by card networks. Needs a cannabis-specialist provider. |
| **ACH / bank transfer** (Aeropay, Dutchie Pay) | Purpose-built for cannabis, legitimate, requires the customer to link a bank account. |
| **Card via a mainstream processor** ❌ | Will result in account termination. Not an option. |

**Recommendation: cash-at-handoff for Phase 4**, with the `payments` table shaped
so an integration drops in later without a migration. It is what the business
almost certainly does today, it removes PCI scope entirely from this phase, and
it lets the phase be about *orders* rather than about a payment integration.

**I need your decision here.** If ACH is wanted, that is a vendor selection and
roughly doubles the phase.

---

## 6. Michigan compliance

**Purchase limits.** The capability deferred in `CART.md` §10 lands here. Adult-use
limits are per-customer, per-day, and expressed in cannabis-equivalent weight,
with different classes converting at different rates. Proposal: a
`purchase_limit_rules` table (class → grams-equivalent per day) plus a check at
order placement that sums the customer's completed orders for the day. Enforced
at the **order boundary**, not in the bag — a limit reached mid-browse should not
silently empty a cart.

**Age.** `date_of_birth` is already required at sign-up and checked at 21+.
Phase 4 adds: re-check at placement, snapshot to the order, and record a
physical ID check at handoff. **The handoff check is the legally load-bearing
one** — the account's stored date of birth is a claim, not verification.

**METRC.** Michigan requires seed-to-sale reporting. The order schema carries
what a report needs (SKU, weight, quantity, timestamp, store). **Proposal: do not
integrate in Phase 4.** Record everything faithfully, expose it, and treat the
API integration as its own phase with its own credentials and failure semantics.
An unreliable compliance integration is worse than a clean manual export.

**Delivery.** Michigan restricts delivery to certain licence classes and
municipalities. `stores.delivery_radius_meters` covers distance; municipal rules
need a checked list of permitted areas.

---

## 7. Tax

Michigan adult-use: **10% excise** plus **6% sales tax**. Both stored as separate
snapshot columns.

Excise applies to adult-use, not medical, so the rate depends on the sale type —
which means a `sale_type` on the order even if only one is supported at first.
Tax rules change by legislation; they must be data, not constants in a
calculation, and every order must record the rate applied so a historical order
can be reproduced exactly.

---

## 8. The checkout flow

Server Actions throughout, no-JS functional, matching Phase 3.

```
/bag → "Checkout"
  → create draft order (reserve inventory)      ← requireVerifiedUser()
/checkout/fulfilment   pickup or delivery, address, window
/checkout/review       prices, taxes, limits, age confirmation
  → place order (transaction: commit reservation, snapshot totals, audit)
/orders/[number]       confirmation, then status
```

**Idempotency.** A double-submitted "Place order" must not create two orders. The
draft order id is the idempotency key: placement is a conditional `UPDATE …
WHERE status = 'draft'`, the same claim pattern the cart merge and token
consumption already use. Exactly one submit wins.

**Prices are re-read and re-verified at placement.** The review page shows live
prices; placement recomputes and, if anything changed, stops and shows the
customer rather than charging a different number than displayed.

---

## 9. Audit events

Additive to `audit_event` (migration 0008, **one-way**, same caveat as 0006/0007):

```
ORDER_DRAFTED          ORDER_PLACED           ORDER_CANCELLED
ORDER_STATUS_CHANGED   PAYMENT_RECORDED       PAYMENT_FAILED
INVENTORY_RESERVED     INVENTORY_RELEASED     PURCHASE_LIMIT_BLOCKED
AGE_VERIFIED_AT_HANDOFF
```

Same privacy rule as Phase 3.5: no address, no card reference, no personal detail
in `summary`. `order_events` carries the operational history; the audit log
carries the security and compliance record.

---

## 10. What I recommend NOT building in Phase 4

- **METRC integration** — its own phase (§6)
- **Discounts and promotions** — the cart's read-time pricing supports them later without schema change; adding them here doubles the tax surface
- **Refunds and returns** — needs a payment integration to be meaningful
- **Driver assignment and routing** — Phase 7 territory; `fulfilments` leaves room
- **Multi-store inventory** — `store_id` is on the order; per-store stock is a catalog change
- **Loyalty, gift cards, subscriptions**

---

## 11. Decisions I need before implementation

1. **Payment method** (§5). Cash-at-handoff, or an ACH vendor? This one changes scope most.
2. **Reserve at draft with a TTL**, or at placement only? I recommend draft + 15 minutes.
3. **Pickup only, or pickup and delivery** in this phase? Delivery adds address validation, radius checks and municipal rules.
4. **Purchase limits enforced now**, or recorded now and enforced next? I recommend enforced — it is a licence condition.
5. **Are there real product and store records** to build against, or does this phase also need a seeded production catalog? Production currently has an empty catalog and one store record's worth of assumptions.

---

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Overselling a physical product | Reservation with an atomic conditional update (§4) |
| Charging a different price than displayed | Re-verify at placement; stop rather than adjust (§8) |
| Double orders from a double submit | Draft id as idempotency key, conditional claim (§8) |
| Exceeding a state purchase limit | Enforced at placement against completed same-day orders (§6) |
| Selling to someone underage | DOB at signup + snapshot + physical check at handoff (§6) |
| Tax rules changing | Rates as data, snapshotted per order (§7) |
| Payment processor terminating the account | Do not use a mainstream card processor (§5) |
| Reservation leak from abandoned checkouts | TTL plus a release sweep (§4) |

---

## 13. Testing

Same discipline as Phases 3 and 3.5: real HTTP, no-JS paths exercised, browser
verification for anything whose failure is only visible on screen, and
**identity-based cleanup only — never a shape-based delete.**

New ground this phase: concurrency tests for reservation (two customers, one
unit), idempotency tests for double placement, arithmetic tests for tax and
totals with awkward values, and purchase-limit tests at and over the boundary.

**Money deserves property-based tests.** Rounding, splitting tax across lines,
and discount interaction are where cent-level errors hide, and example-based
tests tend to encode the same assumption twice.
