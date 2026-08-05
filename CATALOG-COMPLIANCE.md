# Catalog Compliance & Checkout Readiness (Phase 4.4)

Branch `feat/checkout-orders`. Migrations 0008–0015, development only —
production remains on 0007.

> **CHECKOUT IS DISABLED AND DEFAULTS TO DISABLED.** `CHECKOUT_ENABLED` must be
> the literal string `true`; absent means off. Nothing in this phase turns it on.

---

## 1. The admin interface

`/admin/catalog/compliance` — where a person states what each product
physically is.

Per variant: product and variant name, SKU, active status, current class, basis,
measurement value and unit, **usable-equivalent grams per unit**, **concentrate
grams per unit**, **immature-plant count per unit**, a ready/not-ready verdict,
and the exact reason it is not eligible.

Filters: all · ready · not ready · `other` · missing measurement · unsupported
basis · zero-equivalent · include inactive · by class.

The per-unit figures are computed **server-side by the same code that evaluates
the limit at checkout**. A preview doing its own arithmetic in the browser would
eventually disagree with the thing it previews, and the disagreement would
surface as a refused order nobody could explain.

### Nothing is inferred

No product name, category, description, THC figure or prior seed data is read to
decide a classification. There is no "suggest", no mapping table, no
"classify all". A classification is a factual claim about a physical item made
by someone who can be asked to justify it — a plausible inference from
"Blackberry Gummies" is exactly the mistake that looks right in a spreadsheet
and is wrong on a shelf.

**The 33 development variants were not rewritten.** They remain `other`, remain
listed as not ready, and remain unsellable.

### Bulk

Allowed only with explicit selection. The operator ticks the variants; one
class, basis and measurement applies to all of them; the form shows every
selected SKU with its before and after; a reason is required; the whole batch is
one transaction. One invalid row rejects all of it — applying half a bulk edit
leaves the operator working out which of forty SKUs actually changed, from a
screen that has already moved on.

---

## 2. Permission and audit

### `catalog_compliance_admin`

A named grant, separate from `compliance_admin` and **not implied by `admin`**.

Publishing the legal caps and deciding which cap a product falls under are
different jobs, usually held by different people. Combining them would mean
anyone who could classify a product could also move the rule it is measured
against — and the verification suite asserts that a `compliance_admin` is
refused the catalog screen, and vice versa.

```bash
npm run perm -- --email=… --grant=catalog_compliance_admin --reason="…" --confirm
```

Enforced **inside every Server Action**, not only on the page. A Server Action
is a public POST endpoint; the HTTP suite proves an ungranted admin who copies
the action id and posts it directly is refused and changes nothing.

### Audit

Every change records the acting user, variant id, previous class/basis/value,
new class/basis/value, the required reason, the timestamp, and request metadata
where available.

**Transactionally mandatory.** `recordAuditEventWithin` throws rather than
swallowing, so a failed audit insert rolls the catalog change back with it.
Missing request metadata degrades to null — that is a degradation. A missing row
is a hole. The suite proves it with a real trigger on `audit_log`, not a stub.

Every row in a bulk batch is audited, including ones whose values did not move:
a batch that touched forty SKUs and audited thirty-one leaves nine an auditor
cannot account for.

### History is never rewritten

Order lines snapshot the values used for their own transaction. A correction
changes what will be sold next, never what was sold before — asserted directly:
place an order, correct the variant, and every snapshot column on the placed line
is byte-identical afterwards.

---

## 3. Validation, server and database

| Class | Basis | Value |
| --- | --- | --- |
| `flower` | `net_weight_grams` | positive grams |
| `concentrate` | `net_weight_grams` | positive grams |
| `infused_solid` | `finished_net_weight_grams` | positive grams |
| `infused_liquid` | `finished_volume_fluid_ounces` | positive fluid ounces |
| `immature_plant` | `unit_count` | positive **whole** number |
| `non_cannabis` | `exempt` | **must be empty** |
| `other`, `edible` | — | unsupported, never sellable |

Enforced server-side in `lib/catalog/compliance.ts` **and** by a database CHECK
constraint (`product_variants_compliance_matrix`, migration 0015).

The constraint is **`NOT VALID`** deliberately: it applies to every future
INSERT and UPDATE while leaving legacy rows untouched. A validating constraint
would fail outright on any database with pre-existing rows, and "make the
migration pass" would mean rewriting classifications — the automatic guessing
this phase refuses. Those rows are already refused by checkout and already
listed by the readiness report. Run
`ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_compliance_matrix;`
once the catalog is clean; it takes SHARE UPDATE EXCLUSIVE, not ACCESS
EXCLUSIVE, so it blocks neither reads nor writes.

Refused: mismatched class/basis, zero, negative, fractional plants, and an
`exempt` basis on a cannabis class. The suite crosses **every class with every
basis** — 36 combinations, 6 legal — so a future class cannot arrive with a
plausible-looking wrong basis.

### Where a non-ready variant is refused

| Point | Behaviour |
| --- | --- |
| Readiness report | **Still listed**, with the reason |
| Add to bag | Refused |
| Draft creation | Refused |
| Order placement | Refused |

---

## 4. Placement revalidation

Placement **reloads authoritative catalog data**; it does not trust the draft
snapshot. Proven three ways:

- A measurement corrected mid-draft (3.5 g → 7 g) is applied at placement: the
  line records 7 g.
- A variant reverted to an unsupported class mid-draft **refuses placement**, no
  order is created, and the inventory allocation is not left in a half state.
- An order placed earlier is untouched by either.

### The race

A correction firing simultaneously with a placement, run four times. The
property asserted is that the snapshot is **whole**: either entirely the old
measurement or entirely the new one, never 3.5 g of measurement recorded against
7 g of equivalent — which is what a torn read would produce.

---

## 5. The checkout kill switch

`CHECKOUT_ENABLED` — a **string**, compared against the literal `'true'`.
`z.coerce.boolean()` treats every non-empty string as true, so
`CHECKOUT_ENABLED=false` would have enabled checkout. The suite asserts that
`false`, `FALSE`, `0`, `1`, `yes`, `True` and `""` all leave it off.

| Disabled | Still works |
| --- | --- |
| Draft creation ✗ | Browsing, bag, accounts ✓ |
| Order placement ✗ | Existing order viewing ✓ |
| | Staff fulfilment, cancellation ✓ |

Placement is gated as well as draft creation: a draft made while checkout was
open must not be placeable after the switch is thrown, or fifteen minutes of
in-flight drafts would defeat it.

### The staleness gate

When enabled, drafts are additionally refused if the last **completed** sweep is
older than **900 seconds** — `RESERVATION_TTL_MINUTES` in seconds. Past a full
reservation window with no sweep there may be expired holds nothing has
released, so the stock figures a new draft would reserve against are no longer
trustworthy.

**A scheduler outage does not take the storefront down.** It stops new drafts
and nothing else — proven by cancelling an order and loading the admin report
while the sweeper is two hours stale. A probe that throws is treated as stale
rather than propagating, so a reporting failure cannot become an outage.

---

## 6. The readiness command

```bash
npm run verify:checkout-readiness
npm run verify:checkout-readiness -- --expect-migrations=16
```

Read-only, safe against production, **exits nonzero if any gate fails**. Prints
PASS/FAIL per check, a final READY/NOT READY, and remediation text for every
failure. No secret, no hostname, no connection string — only a truncated
fingerprint.

Checks: schema version · required tables · guard triggers enabled · rule-overlap
exclusion constraint · catalog matrix constraint · role is not superuser · does
not own protected tables · cannot DELETE/UPDATE protected tables · exactly one
rule in force per supported class · no zero conversions · no overlapping windows
· active variants exist · none unclassified/`other`/`edible`/unsupported · every
active cannabis variant has a compatible positive measurement · none converts to
zero · a licensed pickup store exists · inventory records coherent · sweeper
completed within 900 s · `CRON_SECRET` set · **checkout still disabled during
preflight**.

`test:readiness` verifies the gate's own contract: that each failure exits
nonzero, that every failure has a remediation line, that nothing is leaked, and
that **row counts are unchanged** across a run.

### Current development output

```
NOT READY — 23 passed, 13 failed
```

Failing: 10 privilege checks (development uses one owner role), the unclassified
catalog, the sweeper, and `CRON_SECRET`. All correct for development.

---

## 7. Migration rehearsal

```bash
npm run rehearse:migration
```

Creates a throwaway database, brings it to **0007 — production's schema
version** — then applies 0008 → latest exactly as production will.

### Result

```
REHEARSAL PASSED
  baseline 0000–0007      8113 ms
  production step 0008+   6929 ms
  final journal entries   16
```

Post-migration: all tables present, both guard triggers enabled, both
constraints present, `btree_gist` installed, 8 `cannabis_class` values, 5
`measurement_basis` values, 2 `admin_permission` values.

### Locks

| Statement | Lock |
| --- | --- |
| `CREATE TABLE` / `CREATE INDEX` | ACCESS EXCLUSIVE, new objects only |
| `ADD COLUMN` (nullable) | ACCESS EXCLUSIVE, metadata-only, brief |
| `ADD CONSTRAINT … NOT VALID` | ACCESS EXCLUSIVE, **no table scan** |
| `ALTER TYPE … ADD VALUE` | no rewrite, **one way** |
| `ALTER COLUMN TYPE numeric(18,11)` (0014) | **table rewrite** |
| `CREATE EXTENSION btree_gist` (0011) | elevated rights required |

The whole step runs in one transaction: a failure rolls all of it back, and the
lock is held for the full ~7 s.

### Recovery

Forward only; there are no down migrations. A failed step rolls back
automatically. A **succeeded** step cannot be undone past an enum addition —
recovery is a point-in-time restore of the Neon branch. **Take the restore point
immediately before migrating and record it.**

### What this does NOT prove

⚠️ **The rehearsal database is empty.** It proves the sequence applies cleanly
from production's schema version. It proves nothing about production data
volume or shape — a migration slow against a million order lines, or failing on
a row shape only production holds, is not exercised. **Only a restored copy
tests that**, and it needs credentials this environment does not have.

It also proves nothing about catalog correctness. No invented rehearsal data is
offered as evidence about real products.

Isolation is a separate **database** on the same endpoint, not a branch — a
branch needs `NEON_API_KEY`, which is not available here. Isolated from the
development database; not from the development endpoint. **Never point it at
production.**

---

## 8. Remaining steps requiring a person

### The database owner

1. Run the §8 privilege SQL in [PURCHASE-LIMITS.md](PURCHASE-LIMITS.md) —
   create `cloudmarket_app`, revoke ownership and the protected privileges.
2. Point Vercel Production `DATABASE_URL` at the limited role; keep
   `DATABASE_URL_UNPOOLED` as the owner for migrations.
3. Take a restore point, then apply 0008–0015 through the gated sequence.
4. Optionally repeat the rehearsal against a **restored copy of production** —
   the only thing that tests real data volume.
5. `ALTER TABLE product_variants VALIDATE CONSTRAINT …` once the catalog is clean.

### The compliance reviewer

6. ~~Confirm the classification matrix and the three caps.~~ **Complete —
   approved 2026-08-05**, recorded in [COMPLIANCE.md](COMPLIANCE.md) §7.
7. Publish the approved values through `/admin/purchase-limits` when the
   production sequence reaches that step. Publication is one-way; the
   development seeder refuses production.

### The catalog operator

8. Enter real products with a real licensed store record.
9. Classify **every** variant at `/admin/catalog/compliance`, by hand, with a
   reason. Nothing may be inferred.
10. `npm run verify:catalog` until READY.

### Then, and only then

11. Set `CRON_SECRET`; confirm the Vercel plan supports the cron interval
    (per-minute needs Pro/Enterprise; Hobby is daily-only and `* * * * *`
    **fails the deploy**).
12. `npm run verify:checkout-readiness` — must be **READY**.
13. Set `CHECKOUT_ENABLED=true` and redeploy.
