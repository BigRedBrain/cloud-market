# Cart & Bag Foundation (Phase 3)

Persistent shopping bag for guests and customers. **No checkout, no orders, no
payments, no delivery, no discounts, no taxes, no inventory reservation.**

Consumes the frozen design system unchanged. No design file is modified.

---

## 1. Architecture review

### The defining decision: no price column

`cart_lines` stores a **variant id and a quantity**. Nothing else.

Price is re-read from `product_variants` on every render and every mutation. A
`price_cents` column on the line would be a snapshot, and a snapshot is a
*promise* — it says "this is what you will pay". The bag is not entitled to make
that promise; only the order is. Snapshots belong at the checkout boundary,
written once and immutably alongside the payment intent.

Three consequences, all good:

- A price change is a **display** concern, not a data-integrity one. There is no
  reconciliation job, no stale-price detection, no "price changed" modal.
- **The client cannot influence a total**, because it never sends one. A tampered
  payload carrying `priceCents: 1` has nothing to bind to — verified.
- The bag is always **truthful**: it shows what the item costs right now.

### Server Components first, and it degrades without JS

The bag page is a Server Component. Every control — add, increment, decrement,
remove — is a real `<form>` posting a Server Action. **The whole bag works with
JavaScript disabled**, which the test suite proves by construction: it submits
the hidden `$ACTION` fields exactly as a no-JS browser would, and all 48
assertions pass through that path.

`useActionState` adds inline errors when hydrated. It is an enhancement, never a
requirement.

The quantity stepper is two single-purpose forms rather than a number input plus
an "update" button. Each press is one atomic round trip, so the displayed
quantity cannot drift from the server's, and it needs no client state at all.

### Module boundaries

| Module | `'use server'`? | Why |
| --- | --- | --- |
| `lib/bag/core.ts` | no — `server-only` | Identity, resolution, reads |
| `lib/bag/actions.ts` | **yes** | The three form actions, and only those |
| `lib/bag/merge.ts` | no — `server-only` | Takes a `userId` |

`mergeGuestBagIntoUser` was originally written in the actions module and moved
out deliberately. A `'use server'` export is a **public network endpoint**;
exposing a function that takes a `userId` would have let any caller merge an
arbitrary guest bag into an arbitrary account. It is now a plain server function
called only from inside `signInAction`, where the user id has just been
established by authentication.

Brand intensity: bag page at **20%** (DESIGN.md §9) — panel outlines and type, no
smoke, no halftone, no cloud button.

---

## 2. Schema

```
carts ──< cart_lines >── product_variants
  │
  └── users (nullable — null means guest)
```

### `carts`

| Column | Purpose |
| --- | --- |
| `guest_token_hash` | SHA-256 of the guest cookie token. Null once owned by a user. |
| `user_id` | Owner. Null for a guest bag. `cascade` — a bag holds intent, not history. |
| `status` | `active` · `merged` · `converted` · `abandoned` |
| `merged_into_cart_id`, `merged_at` | Idempotency pointer for the merge |
| `last_activity_at` | Guest expiry today; abandoned-cart recovery later, with no schema change |

### `cart_lines`

| Column | Purpose |
| --- | --- |
| `cart_id` | `cascade` |
| `variant_id` | **`restrict`** — a variant in someone's bag must not vanish from under them |
| `quantity` | Positive integer, enforced by a `CHECK (quantity > 0)` constraint |

### Two database-enforced invariants

```sql
-- At most one active bag per customer.
CREATE UNIQUE INDEX carts_one_active_per_user ON carts (user_id)
  WHERE status = 'active' AND user_id IS NOT NULL;

-- One line per variant per bag.
CREATE UNIQUE INDEX cart_lines_cart_variant_unique ON cart_lines (cart_id, variant_id);
```

Both are enforced by Postgres rather than by application discipline, and both are
load-bearing for concurrency (§5). The first is what makes the merge's notion of
"the customer's bag" unambiguous; the second is what makes concurrent adds
collapse into an increment instead of duplicating a line.

### Future compatibility

Not implemented; nothing blocks them:

| Feature | Path |
| --- | --- |
| Abandoned carts | `status='abandoned'` + `last_activity_at` — already present, needs only a query |
| Multi-store / inventory per location | Nullable `store_id` on `carts`; validation reads `inventory_levels` instead of the variant column |
| Discounts | A `cart_discounts` join, applied at read time like pricing. No line changes. |
| Bundles | A line already points at a variant; a bundle variant expands at the order boundary |
| Taxes, delivery fees | Order-level concerns, computed at checkout — deliberately absent from the bag |

**What was deliberately NOT added**: no `currency` column (single-currency
retailer), no `cart_metadata` jsonb, no line-level `discount_cents`, no
`reserved_until`. Each would be a premature commerce abstraction, and the brief
asked not to over-generalise.

---

## 3. Guest identity & security model

A guest bag is addressed by an **opaque 256-bit token** from the CSPRNG, held in
a cookie. The database stores only its SHA-256.

| Property | How |
| --- | --- |
| Nothing sequential or enumerable exposed | Cart PK is a UUID and never leaves the server; the client holds only a random token |
| Database disclosure leaks no bags | Stored hash cannot be replayed as a cookie |
| Forged token fails safe | A bad token is a lookup **miss** — the visitor gets an empty bag, never someone else's |
| Cookie hardening | `httpOnly`, `sameSite=lax`, `secure` in production, `__Host-` prefix in production |
| CSRF | Server Actions carry Next's built-in origin checks |
| Line ownership | Every mutation scopes to `cart_id`, so another bag's line id is a miss, not an authorization hole |

There is **no signature to verify**, which removes a whole class of bug: no
forgery path where a tampered token becomes a *valid* identity for a different
bag. Verified with three attacks — a made-up token, and the cart's real UUID used
as a token, both yield an empty bag.

**Browsing never writes.** `findActiveBag` never creates; only mutations call
`findOrCreateBag`. A crawled storefront does not accumulate cart rows.

---

## 4. Merge algorithm

Runs inside `signInAction` and `signUpAction`, after the session exists.

```
guest bag (active, user_id null)          customer bag (active, user_id = X)
        │                                          │
        ├── claim: UPDATE ... WHERE status='active' ──> lost race? stop
        │
        └── for each guest line:
              skip if variant inactive / deleted / product not active / stock 0
              INSERT ... ON CONFLICT (cart_id, variant_id) DO UPDATE
                SET quantity = least(existing + guest, available, 99)
                                          │
                                          ▼
                          mark guest cart status='merged',
                          merged_into_cart_id = customer cart,
                          clear the guest cookie
```

| Rule | Behaviour |
| --- | --- |
| Preserve the customer's bag | The customer's cart is the target; the guest bag merges *in*, never replaces |
| Identical variants sum | 2 (guest) + 2 (customer) → 4 — verified |
| Cap at available stock | 4 + 4 with stock 5 → **5** — verified |
| Idempotent | Replaying a consumed token does **not** double quantities — verified |
| Destroy guest identity | Cart flipped to `merged`, cookie cleared |
| Skip unpurchasable lines | Sold-out, inactive or unpublished items are dropped silently rather than poisoning the bag |

**Idempotency mechanism.** The claim is an `UPDATE … WHERE status='active'`
returning the row. Only one caller can win. A retry — double-submitted sign-in,
refresh, replayed action — finds the cart no longer `active` and returns
immediately. This is the property that matters most: a merge that runs twice must
be indistinguishable from one that ran once.

The whole merge runs in a transaction, so a failure part-way cannot consume the
guest bag without moving its lines.

---

## 5. Inventory & concurrency

**Nothing is reserved.** Quantity is capped at what is available at the moment of
the write, but holding a variant in a bag reserves nothing, and two customers can
each hold the last unit. That is deliberate for this phase, and the bag page says
so in plain words:

> *Adding to your bag doesn't reserve stock. Items are secured when you place
> your order.*

The alternative — a reassuring "reserved for you" — would be a claim the schema
cannot back.

### The race the brief asked about

> *Two requests adding the final unit must not cause the application to claim
> stock is reserved.*

Both succeed. Both bags contain 1 of the last unit. Neither is told it is
reserved. Stock is decremented at the future order boundary, which is where the
contention is genuinely resolved — with row locking and a real reservation.

### How concurrent writes are made safe

**Check and write are one statement, not two.** The inventory cap is applied
*inside* the SQL, not read-then-written in application code:

```sql
INSERT INTO cart_lines (...) VALUES (...)
ON CONFLICT (cart_id, variant_id) DO UPDATE
  SET quantity = least(cart_lines.quantity + $n, $available, 99)
```

There is no window between reading stock and writing quantity in which another
request can interleave.

**Two simultaneous adds of the same variant** cannot create two lines — the
second conflicts on the unique index and increments instead.

**Two simultaneous first-adds by one signed-in customer** cannot create two
bags — `carts_one_active_per_user` makes it a database-level race: one insert
wins, the loser's `ON CONFLICT DO NOTHING` returns nothing and it re-reads the
winner. No application locking.

**Two simultaneous sign-ins** cannot merge twice — the claim update serialises
them.

### Stale-stock handling on read

The bag never silently edits itself. A line whose stock dropped, whose variant
was retired, or whose product was unpublished is returned **marked** —
`out_of_stock`, `insufficient_stock` or `discontinued` — excluded from the
subtotal, and surfaced to the customer. Charging for something that cannot ship
would be the wrong default; quietly deleting it would be worse.

---

## 6. Accessibility

- **Stepper buttons name their target**: "Increase quantity of Midnight Runtz
  3.5g", not a bare "plus". The icon is `aria-hidden`; the label carries meaning.
- **Quantity is announced** via `aria-label="Quantity: 2"`.
- **Errors use `role="status"`** and appear next to the control that caused them.
- **Availability is never colour alone** — "Sold out", "Only 2 left" are words.
- **Bag lines are a `<ul>`/`<li>`**, so the count is announced.
- **Disabled states are real `disabled` attributes**, so the decrement button at
  quantity 1 is properly inert rather than merely styled.
- Everything works **without JavaScript**.

---

## 7. Performance

- **Bag render: 3 queries.** Cart lookup → lines joined to variants/products/
  categories → primary images in one `inArray`. No N+1 regardless of line count.
- **Header count: 1 aggregate query**, no joins and no pricing — the nav needs a
  number, not a bag.
- **Reads never write.** Browsing creates no rows.
- **Indexes**: `cart_lines(cart_id)`, `cart_lines(variant_id)`,
  `carts(user_id)`, `carts(status)`, `carts(last_activity_at)`, plus the two
  unique indexes.
- Mutations are a single upsert plus a `last_activity_at` touch.

**Known cost**: every page rendering the nav count issues one extra query. At
this scale it is negligible; if it ever shows up, the count belongs in a cached
segment rather than in each page.

---

## 8. Migration summary

**`0005_flimsy_shinko_yamashiro.sql`** — additive only.

| | |
| --- | --- |
| New enum | `cart_status` |
| New tables | `carts`, `cart_lines` |
| New indexes | 7, including 2 unique (one partial) |
| Constraints | `cart_lines_quantity_positive` — `CHECK (quantity > 0)`, hand-added |
| Existing tables touched | **none** |

**Applied to the development branch only.** Production remains on 0004, and was
verified as development before every write:

```
is production? no      (both pooled and direct)
```

---

## 9. Test results

```
npm run test:bag    48 passed, 0 failed
npm run test:auth   28 passed, 0 failed   (regression)
npm run test:e2e    89 passed, 0 failed   (regression — sign-in/up changed)
```

Driven over real HTTP with per-device cookie jars, submitting hidden `$ACTION`
fields as a no-JS browser would.

| Required case | Result |
| --- | --- |
| Add one variant | ✅ |
| Add same variant twice | ✅ increments, no duplicate line |
| Quantity increase / decrease | ✅ |
| Remove line | ✅ |
| Empty bag | ✅ empty state |
| Invalid variant | ✅ unknown + malformed uuid rejected |
| Inactive variant | ✅ |
| Draft / archived product | ✅ |
| Out-of-stock variant | ✅ |
| Quantity > available | ✅ capped, customer told |
| Price changes after add | ✅ bag follows live; old price gone |
| Guest persistence | ✅ across requests |
| Authenticated persistence | ✅ bound to user, no guest token |
| Guest → customer merge | ✅ |
| Same variant in both bags | ✅ sums to 4 |
| Combined quantity > stock | ✅ capped at 5 |
| Repeated merge idempotent | ✅ no doubling |
| Suspended account | ✅ signed out of the bag |
| Forged guest identity | ✅ 3 attacks, all yield empty bag |
| No client price influences totals | ✅ price fields ignored |
| Auth regression | ✅ 28 + 89 |

### Bug the suite caught

`getBag` interpolated a JS array into raw SQL (`any(${slugs})`), which Postgres
rejected with *malformed array literal* — the bag page threw on every render with
items in it. Replaced with Drizzle's `inArray`. This is exactly the class of bug
that only shows up against a real database with real rows.

---

## 10. Known limitations

1. **No inventory reservation.** By design. Two customers can hold the last unit;
   contention resolves at the order boundary.
2. **No guest-bag garbage collection job.** `last_activity_at` and a 30-day
   cookie exist, but nothing prunes expired guest carts yet. A scheduled delete
   is one query; it has not been written.
3. **Merge drops unpurchasable guest lines silently.** A guest whose item sold
   out before sign-in is not told it was dropped. Telling them needs somewhere to
   surface it on the post-sign-in page, which is a UI decision I did not want to
   make unilaterally.
4. **Bag count adds one query per page** that renders the nav.
5. **`revalidate = 60` on the root layout is inherited.** `/bag` is dynamic
   (verified `ƒ` in the build), so it is unaffected — but any future bag-adjacent
   page must confirm the same, because a cached bag would be a serious bug.
6. **The 99-per-line cap is arbitrary.** It prevents absurd quantities; it is not
   a business rule and should be replaced by one.
7. **No optimistic UI.** Every action is a round trip. Correct and simple, but a
   slow connection feels slow — worth revisiting with `useOptimistic` once the
   flows settle.
