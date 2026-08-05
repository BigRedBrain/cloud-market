# Phase 4 — Checkout & Orders

Merges `feat/checkout-orders` into `main`. Migrations **0008 → 0015**.

> **Production remains on migration 0007. Checkout remains disabled. The
> production catalog remains unclassified. No production rule has been
> published. Production-role verification has not yet been executed. A real
> production-data rehearsal still requires credentials this environment does not
> have.**
>
> Merging this changes nothing in production until an operator works through
> [PHASE-4-RELEASE.md](PHASE-4-RELEASE.md).

---

## What this adds

**Orders and immutable snapshots.** `orders`, `order_lines`, `order_events`,
`payments`, `fulfilments`. A cart line is a pointer — "whatever this costs now".
An order line is a record: SKU, name, price, per-line tax, weight, potency,
classification, measurement, conversion ratio and rule id are copied at
placement and never read from the catalog again. A renamed product or a
corrected classification cannot change what an order says was sold.

**Inventory reservation.** `available = inventory_quantity - reserved_quantity`.
Two counters, because with one an expired draft and a completed sale are
indistinguishable afterwards. Reserved at draft with a 15-minute TTL, committed
at placement (not at payment — payment is cash at handoff), released on expiry
or cancellation. Every move is one conditional UPDATE with the check inside the
write; every transition is idempotent through `orders.inventory_state`.

**Cash at handoff.** No payment processor — cannabis is federally illegal and
the card networks prohibit it. `payments` is provider-neutral so ACH can be
added without a migration. One open obligation per order, enforced by a partial
unique index.

**Append-only events.** `order_events` is the history; `orders.current_status` is
a projection written in the same transaction by the single function permitted to
change it. If they ever disagree, the log wins.

**Versioned purchase-limit governance.** Rules are immutable: publishing inserts
a new version and closes the previous one. Enforced by two triggers, an
exclusion constraint, a check constraint and three `RESTRICT` foreign keys —
the application is only one of the guards. Gated on a named `compliance_admin`
grant (**not** implied by `admin`), with step-up re-authentication, a required
reason, and an audit row written *inside* the publishing transaction.

**Michigan CRA compliance.** Three independent caps **per transaction** —
usable-marijuana equivalent (2.5 oz, exactly 70.87380781250 g), concentrate
(15 g), immature plants (3). Flower and concentrate count 1:1 by gram weight;
solid infused converts by finished mass (16 oz = 1 oz), liquid by finished
volume (36 fl oz = 1 oz). THC never enters the calculation. All arithmetic is
exact `bigint` rationals — an ounce and the liquid conversion cannot be
represented in binary floating point.

**Catalog compliance administration.** `/admin/catalog/compliance`, gated on a
separate `catalog_compliance_admin` grant. Every classification is entered by a
person with a reason and audited transactionally. **Nothing is inferred** from
names, categories, descriptions, THC values or seed data.

**Checkout kill switch.** `CHECKOUT_ENABLED` defaults to disabled. Disabled
stops draft creation and placement only — browsing, the bag, accounts, existing
orders and staff fulfilment keep working.

**Expired-draft scheduler.** Vercel Cron → an authenticated route, bounded
batches, one transaction per draft, structured logs, and a health signal
reporting the last *completed* run. Stock no longer waits for a customer who is
not coming back.

**Production privilege separation.** The application role must not own the
protected tables — otherwise it can disable the triggers guarding them.
`verify:privileges` proves the separation from outside.

**Verification tooling.** `verify:catalog`, `verify:privileges`,
`verify:checkout-readiness` (read-only, exits nonzero on any failure) and
`rehearse:migration`.

**The limit seeder refuses production.** `db:seed:limits:dev` fails closed
before opening a connection: a known production fingerprint is refused
unconditionally, a production platform is refused, and an absent or unrecognised
`SEED_TARGET_ENVIRONMENT` is refused. No flag overrides it. Production rules are
published only through `/admin/purchase-limits`, which the seeder bypasses
entirely — and rule publication cannot be undone.

---

## Forward-only and one-way

- **24 enum values** across 0008, 0009, 0013 and 0015 cannot be removed.
  Rollback past them means restoring a backup, not running a down migration.
- **Publishing a purchase limit rule cannot be undone.** A mistake is corrected
  by publishing another; the mistake stays on the record.
- **Rules cannot be edited or deleted**, by trigger and by privilege.
- **Order lines never change** after placement.

---

## Deliberately out of scope

METRC, delivery and driver routing, discounts, refunds, loyalty, gift cards,
multi-store inventory, a payment processor, a staff fulfilment UI, two-person
approval for rule publication, and any automatic or AI-assisted product
classification.

---

## Test totals

| Suite | | Suite | |
| --- | --- | --- | --- |
| `test:compliance` | 92 | `test:recovery` | 151 |
| `test:governance` | 104 | `test:e2e` | 94 |
| `test:catalog-admin` | 88 | `test:bag` | 64 |
| `test:limits:http` | 59 | `test:browser` | 26 |
| `test:sweeper` | 53 | `test:browser:guard` | 25 |
| `test:concurrency` | 28 | `test:auth` | 28 |
| `test:readiness` | 22 | `test:email` | 12 |
| `test:math` | 21 | `test:seed-guard` | 54 |

**921 assertions, 0 failures.** `lint` 0 errors (1 pre-existing warning),
`typecheck` clean, `build` clean.

Migration rehearsal from 0007: baseline 8.1 s, production step 6.9 s, 16 journal
rows, all objects present.

---

## Review notes

- `ARCHITECTURE-4.md` §6 is **superseded** — it proposed per-day limits with a
  5:1 concentrate weighting, which the CRA guidance contradicted.
  [COMPLIANCE.md](COMPLIANCE.md) is authoritative.
- Migrations must be applied **before** this code deploys. The currently
  deployed production code touches none of the new columns, so no running
  deployment can write a value incompatible with an unapplied migration.
- `product_variants_compliance_matrix` ships **`NOT VALID`**: it binds every new
  and updated row immediately, leaves legacy rows accepted (and unsellable), and
  is validated separately once the real catalog passes readiness.
