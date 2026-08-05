# Phase 4 — Production Release Runbook

Commit `807cd50` (plus this review). Migrations **0008 → 0015**, forward only.

**Read the whole document before starting.** Steps are ordered because the order
is load-bearing: **migrations before privileges**, migrations before code, rules
before catalog, readiness before enablement.

> Every command shown is safe to run. No command in this runbook prints a
> credential. Where a connection string is needed it is set as an environment
> variable in the operator's own shell and never echoed.

> ### ⚠️ The order of §2–§8 changed on 2026-08-05
>
> Privilege hardening now runs **after** the migrations, not before. The previous
> order could not complete. See **[Why the order changed](#why-the-order-changed)**
> before following a printed copy of the old runbook.

---

## Rehearsal outcome — 2026-08-05

A restored-production rehearsal was executed against an isolated Neon child
branch of production. Full report: **[PHASE-4-REHEARSAL.md](PHASE-4-REHEARSAL.md)**.

| Measure | Result |
| --- | --- |
| Identity gates | **24 / 24 passed** |
| Migrations `0008`–`0015` | **8 → 16 journal rows in 6927 ms** |
| Lock waits | **zero** — in an isolated copy with an empty catalog |
| Post-migration objects | **19 / 19** |
| `verify:privileges` | **44 passed, 0 failed** |
| Rule publication through `/admin/purchase-limits` | **10 / 10** |
| Scheduler | **8 / 8** |
| `verify:checkout-readiness` | **35 / 36** — the one failure is the absent real catalog |
| Order-lifecycle scenarios | **272 / 273** — the one failure was a test defect (F6), since fixed |

> **Zero lock waits does NOT predict zero lock waits in production.** It was
> measured on an isolated copy with no concurrent clients and an empty catalog.
> A rewrite holding ACCESS EXCLUSIVE behind live traffic behaves differently, and
> the rehearsal says nothing about that.

**Recommendation: GO to migrate.** **NO-GO to enable checkout** until the real
production catalog exists, every active variant is classified, and all readiness
gates pass.

The rehearsal also proved that `0008`–`0015` apply successfully to **production's
actual schema lineage** — not merely to a schema rebuilt from this repository.
See §0's note on journal hashes.

---

## 0. Migration review — read before scheduling the window

### The sequence

| # | What it does | Locks | Scans rows? | Reversible |
| --- | --- | --- | --- | --- |
| **0008** | 6 tables, 8 enums, 2 columns on `product_variants`, **10** `audit_event` values | ACCESS EXCLUSIVE on new objects; brief metadata lock for the 2 columns | No | Tables yes; **enum values NO** |
| **0009** | `user_permissions`, rule versioning columns, `order_lines.purchase_limit_rule_id`, 2 guard triggers, **7** audit values | ACCESS EXCLUSIVE, metadata only | No | Triggers yes; **enum values NO** |
| **0010** | `CREATE OR REPLACE` the guard function | None on tables | No | Yes |
| **0011** | `scheduler_runs`, `CREATE EXTENSION btree_gist`, rule-overlap EXCLUDE constraint | ACCESS EXCLUSIVE; the EXCLUDE constraint **builds an index over `purchase_limit_rules`** | Yes — but that table holds one row per class per version | Yes |
| **0012** | Partial unique index on `scheduler_runs` | ACCESS EXCLUSIVE on a table just created | No | Yes |
| **0013** | 4 `cannabis_class` values, `measurement_basis` enum, columns on variants/order lines/rules, guard function extended | ACCESS EXCLUSIVE, metadata only; **2 `SET DATA TYPE` on `orders`** | **Yes — rewrites `orders`** | Columns yes; **enum values NO** |
| **0014** | Cap columns → `numeric(18,11)` | ACCESS EXCLUSIVE | **Yes — rewrites `purchase_limit_rules`** | Yes |
| **0015** | 3 `audit_event` values, 1 `admin_permission` value, `product_variants_compliance_matrix` **NOT VALID** | ACCESS EXCLUSIVE, brief | **No — `NOT VALID` skips the scan** | Constraint yes; **enum values NO** |

### Required extensions and privileges

- **`btree_gist`** (0011). `CREATE EXTENSION` needs elevated rights; on Neon the
  default owner has them. **Verified in rehearsal** — it installed under
  `neondb_owner`, which is *not* a superuser. **If it fails the migration aborts
  — do not work around it by dropping the constraint.**
- Migrations run as the **owner** (`DATABASE_URL_UNPOOLED`), not as the
  restricted application role. The application role cannot and must not be able
  to run them.

### Which operations scan or rewrite

Only three touch existing data, and all three are on tables that are effectively
empty in production today:

- **0011** builds a GiST index over `purchase_limit_rules` — production has **no
  rules at all** at this point, so it is instant.
- **0013** rewrites `orders` for two numeric widenings — production has **no
  orders**.
- **0014** rewrites `purchase_limit_rules` — again, empty.

**Confirmed by rehearsal against a real copy:** all three touched **zero rows**,
and the whole sequence completed in 6927 ms — the same as against an empty
database, because production *is* empty.

**This is why the window is short today and would not be later.** Running these
after the shop has been trading for a year is a different operation.

### Irreversibility, and why rollback means restore

`ALTER TYPE … ADD VALUE` **has no inverse**. 0008, 0009, 0013 and 0015 add 24
enum values between them. Once committed they cannot be removed without
recreating the type, which would require dropping every column that uses it.

There are **no down migrations**, by design. Recovery from a *succeeded*
migration is a **point-in-time restore of the Neon branch** to before it ran.
Recovery from a *failed* migration is automatic — the whole step runs in one
transaction and rolls itself back.

**Take and record the restore point immediately before migrating.**

### 0015 and the `NOT VALID` constraint

`product_variants_compliance_matrix` is added **`NOT VALID`** deliberately:

- It **binds every INSERT and UPDATE from the moment it is created.** A new or
  edited variant cannot be written with an incompatible class/basis/value.
- It **does not scan the table** and does not fail on existing rows. Legacy rows
  classified `other` remain accepted — and remain unsellable, because checkout,
  the bag and the readiness gate all refuse them.
- `VALIDATE CONSTRAINT` is a **separate step, run only after the real catalog
  passes readiness.** It takes SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE, so
  it blocks neither reads nor writes and **can be run outside the maintenance
  window**.

Validating it during the migration would fail outright on any database with
legacy rows, and "make the migration pass" would mean rewriting classifications
— inventing legal facts, which this release refuses to do.

### Deployment ordering

**Migrations first, then code.** Verified against the diff: the new columns
(`measurement_basis`, `measurement_value`, the rule ratio columns, the order-line
snapshot columns) are read and written only by code introduced in this release.

The currently-deployed production code (at 0007) touches none of them — orders
do not exist there — so **no already-running deployment can write a value
incompatible with a migration that has not yet been applied.** The reverse
ordering is the hazard: deploying this code before 0013 would query columns that
do not exist. Do not do it.

### A note on journal hashes

Two of production's eight recorded migration hashes — for `0000` and `0004` — do
not match this repository's current `drizzle/*.sql` files, while the other six
do. Both files have exactly one commit each and were never edited after it, so
production was migrated from a working state that was adjusted before commit.

**No action is required, and nothing may be done about it.** `drizzle` selects
migrations by `created_at` versus `folderMillis`, never by hash, so the mismatch
is inert; all eight rows map cleanly onto `0000`–`0007` by timestamp.

> **Do not rewrite production migration history, and do not alter historical
> journal rows** to make the hashes agree. There is no benefit and the rows are a
> record of what was actually applied.

It is recorded because it means production's 0007 schema is **not byte-identical**
to what `npm run rehearse:migration` rebuilds from this repository. That is
precisely why the restored-copy rehearsal mattered: it proved `0008`–`0015` apply
to production's **actual** schema lineage, which a rebuild cannot prove.

---

<a id="why-the-order-changed"></a>

## Why the order changed

Until 2026-08-05 this runbook applied the privilege-hardening SQL **before** the
migrations. **That order cannot complete.** The rehearsal ran the block verbatim
against a real 0007 production schema and four of its ten statements failed:

```
   1. OK    CREATE ROLE                       6. ERROR GRANT UPDATE(cols) …   42P01
   2. OK    GRANT USAGE ON SCHEMA             7. OK    REVOKE ON audit_log
   3. OK    GRANT ON ALL TABLES               8. ERROR REVOKE ON order_events 42P01
   4. OK    GRANT ON ALL SEQUENCES            9. ERROR REVOKE ON user_perms   42P01
   5. ERROR REVOKE ON purchase_limit_rules   10. OK    ALTER DEFAULT PRIVILEGES
           42P01 relation "purchase_limit_rules" does not exist
```

`purchase_limit_rules`, `order_events` and `user_permissions` are created by
migrations `0008`–`0015`. Before those migrations they do not exist, so every
statement naming them fails.

**What the old order would have left behind.** Run as a script, the block aborts
at statement 5. By then the role has already been granted `SELECT, INSERT,
UPDATE, DELETE` on **all** tables (statement 3), and the operator is left with:

- **broader privileges than intended** on the application role;
- **none** of the compliance REVOKEs — no protection on `purchase_limit_rules`,
  `order_events` or `user_permissions`, which is the entire point of the
  hardening;
- **no `ALTER DEFAULT PRIVILEGES`**, so tables created by the later migrations
  would receive no grants at all;
- a `verify:privileges` run that fails at section [2] with *table not found*, at
  a point in the release where migrations have not yet been applied.

**Do not grant broad table privileges before the new compliance tables exist.**
The grants and the revokes must be applied as one unit, and that is only possible
once every table they name is present.

---

## 1. Before maintenance — preflight and restore point

- [x] **Compliance review complete — approved 2026-08-05.** The caps and the
      classification matrix are recorded in [COMPLIANCE.md](COMPLIANCE.md) §7:
      70.87380781250 g usable-equivalent, 15 g concentrate, 3 immature plants,
      all per transaction. Nothing remains open.
      **Approval authorises the values; it does not publish them** — see §9.
- [x] **Restored-production rehearsal complete — 2026-08-05.** See
      [PHASE-4-REHEARSAL.md](PHASE-4-REHEARSAL.md).
- [ ] **Vercel Pro or Enterprise confirmed**, *or* an approved external
      scheduler selected. Per-minute cron requires Pro/Enterprise; on Hobby
      `* * * * *` **fails the deployment** — it does not degrade to daily.
      If staying on Hobby, remove the `crons` entry from `vercel.json` and point
      the external scheduler at `/api/cron/sweep-drafts` at least every few
      minutes.
- [ ] **`CRON_SECRET` generated** (32+ random bytes) and set in Vercel
      **Production**, marked Sensitive.
- [ ] **`CHECKOUT_ENABLED` is unset or `false`** in Production.
- [ ] **Restore point taken and its identifier recorded here:** `__________`

> The restore point is the only recovery path from a *succeeded* migration.
> Take it immediately before §3, not hours earlier.

---

## 2. Confirm production is at `0007`

Run in the **same shell** that will run the migration, immediately before it.

```bash
# Record what the live application reports first
curl -s https://cloudmarket.cc/api/health
```

- [ ] Fingerprint recorded: `__________`
- [ ] Start time recorded: `__________`

```powershell
$env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"   # the OWNER
$env:PRODUCTION_POOLED_URL = "<production POOLED string>"

node scripts/verify-migration-target.mjs https://cloudmarket.cc `
  --expect-migrations=8 `
  --require-table=carts,cart_lines `
  --forbid-table=orders,user_permissions,scheduler_runs
```

**`--expect-migrations=8`, not 7.** The gate counts journal *rows*: `0000`
through `0007` is eight of them.

- [ ] Gate reports **GO**.

> **A NO-GO is a stop, always.** Read the reason and resolve it. There is no
> circumstance in which an operator should proceed past a NO-GO on this gate.
> (When verifying an isolated rehearsal copy rather than production, use
> `--rehearsal`, which enforces the *opposite* production-fingerprint
> expectation while keeping every other identity check. It is a different mode,
> not a way to silence an objection.)

---

## 3. Migrations `0008` → `0015`, as the owner

```bash
npx drizzle-kit migrate
```

- [ ] Completion time recorded: `__________`
- [ ] Warnings recorded: `__________`

Rehearsal reference: 6927 ms total, exit code 0, zero lock waits **in isolation**.

---

## 4. Confirm sixteen journal rows and all expected objects

```powershell
node scripts/verify-migration-target.mjs https://cloudmarket.cc --expect-migrations=16
```

- [ ] Journal at **16 rows** (`0000`–`0015`).
- [ ] `orders`, `order_lines`, `order_events`, `payments`, `fulfilments`,
      `purchase_limit_rules`, `user_permissions`, `scheduler_runs` all present.
- [ ] Both guard triggers on `purchase_limit_rules` enabled (`tgenabled = 'O'`).
- [ ] `purchase_limit_rules_no_overlap` present.
- [ ] `product_variants_compliance_matrix` present (**NOT VALID** — expected).
- [ ] `btree_gist` installed.
- [ ] Enum counts: `cannabis_class` 8, `measurement_basis` 5,
      `admin_permission` 2.

> **Do not publish limit rules yet.** Rules are published through the admin
> screen, by a named grant holder, after re-authentication — §9, not here.

---

## 5. Privilege hardening, as the owner

**Only now**, with every table it names in existence.

```sql
-- Create the restricted application role. Use SQL, not the Neon console:
-- console-created roles are granted neon_superuser and will fail the audit.
CREATE ROLE cloudmarket_app WITH LOGIN PASSWORD '<generated>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

GRANT USAGE ON SCHEMA public TO cloudmarket_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cloudmarket_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cloudmarket_app;

REVOKE DELETE, TRUNCATE, UPDATE ON purchase_limit_rules FROM cloudmarket_app;
GRANT  UPDATE (effective_until, superseded_by_rule_id, updated_at)
       ON purchase_limit_rules TO cloudmarket_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log    FROM cloudmarket_app;
REVOKE UPDATE, DELETE, TRUNCATE ON order_events FROM cloudmarket_app;
REVOKE INSERT, UPDATE, DELETE ON user_permissions FROM cloudmarket_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cloudmarket_app;

-- The migration journal. READ ONLY, and required: verify:checkout-readiness
-- reads it as the application role and aborts without these two grants.
GRANT USAGE ON SCHEMA drizzle TO cloudmarket_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO cloudmarket_app;
```

> The column-level `GRANT UPDATE` **must** follow the table-level `REVOKE
> UPDATE`, not precede it. Reversed, the revoke removes the column grants too.

> **The `drizzle` grants are SELECT and USAGE only.** Do **not** grant `INSERT`,
> `UPDATE`, `DELETE` or `CREATE` on the `drizzle` schema or the journal, and do
> not transfer ownership of either. A role that can write the journal can mark a
> migration as applied without applying it, or hide one that was — which would
> defeat every schema check in this runbook. The application only ever needs to
> *read* which migration the database is on.

- [ ] All statements succeeded. If any failed, stop — do not proceed with a
      partially hardened role.

*(`GRANT … ON ALL SEQUENCES` is a no-op today: the schema has no sequences at
either 0007 or 0015. It is kept because a future migration may add one.)*

---

## 6. Repoint the application connection

- [ ] Set Vercel Production `DATABASE_URL` to the **`cloudmarket_app`** string.
- [ ] Leave `DATABASE_URL_UNPOOLED` as the **owner** — migrations need it.
- [ ] Redeploy so the application picks up the new role.

---

## 7. `verify:privileges`, as the restricted role

```bash
$env:DATABASE_URL = "<production app connection string>"
npm run verify:privileges
```

Run it with the connection string the deployed application uses — **not** the
owner's. Checking the wrong role passes for the wrong reason.

Expected:

```
Production application role — privilege audit (read only)

  database fingerprint: <12 hex chars>
  connected as:         cloudmarket_app

[1] The role is not a superuser
  PASS  the application role is not a superuser
[2] The role does not own the protected tables
  PASS  does not own or inherit ownership of purchase_limit_rules — owner is "neondb_owner"
  …
[10] The migration journal is readable but not writable
  PASS  can USAGE the drizzle schema
  PASS  can SELECT drizzle.__drizzle_migrations
  PASS  cannot INSERT into the migration journal
  …
==========================================================
ALL REQUIRED PRIVILEGES CORRECT — 54 PASS, 0 WARN
==========================================================
```

- [ ] **Every check PASS.** Do not proceed on any FAIL.
- [ ] Confirm the printed fingerprint matches `/api/health`.

---

## 8. Application deployment

- [ ] Deploy with **`CHECKOUT_ENABLED=false`** (or unset — absent means off).

Verify, as a real user:

- [ ] Storefront loads; product pages render.
- [ ] Sign in, sign out, account pages.
- [ ] Bag: add, update, remove.
- [ ] Admin pages load for an administrator.
- [ ] Existing-order viewing works (no orders yet — confirm the route does not
      500).
- [ ] **Checkout is refused** with the "not open yet" message.

Cron:

```bash
# No credential — must be 401
curl -s -o /dev/null -w "%{http_code}\n" https://cloudmarket.cc/api/cron/sweep-drafts

# Wrong credential — must be 401
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong" https://cloudmarket.cc/api/cron/sweep-drafts
```

- [ ] Both return **401**. (If `CRON_SECRET` is unset the route returns **503**
      and does not run — also acceptable, but set the secret before continuing.)
- [ ] The scheduled invocation succeeds. Vercel → Project → Cron Jobs shows a
      200.

```bash
curl -s https://cloudmarket.cc/api/health
```

Expected:

```json
{
  "status": "ok",
  "environment": "production",
  "database": { "configured": true, "reachable": true, "fingerprint": "…", "latencyMs": 41 },
  "scheduler": {
    "job": "sweep-expired-drafts",
    "lastSuccessAt": "2026-08-05T…Z",
    "ageSeconds": 37,
    "lastExpired": 0,
    "lastDurationMs": 62
  },
  "timestamp": "…"
}
```

- [ ] `scheduler.ageSeconds` under **180**. Over **900** means checkout would be
      blocked even once enabled.

---

## 9. Compliance setup

- [ ] Grant the named officer:

```bash
npm run perm -- --email=officer@example.com --list
npm run perm -- --email=officer@example.com --grant=compliance_admin \
  --reason="Named compliance officer, <board minute reference>" --confirm
```

- [ ] Publish **only attorney-approved values**, through
      `/admin/purchase-limits`, one class at a time, each with a reason and
      re-authentication.

> **Production purchase-limit rules can be published ONLY through
> `/admin/purchase-limits`.**
>
> `npm run db:seed:limits:dev` is a development/staging tool and **refuses a
> production target outright** — a known production fingerprint, a production
> platform, or an absent/unrecognised `SEED_TARGET_ENVIRONMENT` all fail closed
> before it opens a connection. There is no flag that overrides it.
>
> That refusal exists because the seeder bypasses every control this step
> depends on: the `compliance_admin` grant, step-up re-authentication, the typed
> confirmation, the written reason, and the audit row committed in the same
> transaction as the rule. Rule publication is **one way** — a wrong value can
> only be corrected by publishing another beside it, and the wrong one stays on
> the record forever.
>
> The rehearsal confirmed this end to end on a disposable copy: a published rule
> **cannot be deleted**, and neither can the officer who published it — deleting
> the user is refused by the immutability trigger, because the cascade reaches
> `published_by`.

Record, for each of the six supported classes:

| Class | Rule ID | Effective from (UTC) | Published by |
| --- | --- | --- | --- |
| `flower` | | | |
| `concentrate` | | | |
| `infused_solid` | | | |
| `infused_liquid` | | | |
| `immature_plant` | | | |
| `non_cannabis` | | | |

- [ ] Exactly **one** rule in force per class (the readiness gate checks this).

---

## 10. Catalog setup

- [ ] Create the real licensed store record — real licence number, real address,
      `pickup_enabled = true`.
- [ ] Enter real products and variants.
- [ ] Grant the catalog operator:

```bash
npm run perm -- --email=operator@example.com --grant=catalog_compliance_admin \
  --reason="<who authorised this>" --confirm
```

- [ ] Classify **every** variant at `/admin/catalog/compliance`, **by hand**,
      with a reason on every change.

> **Do not bulk-infer.** Bulk is for a set the operator has explicitly selected
> where one measurement genuinely applies to all of them. A 2 g and a 3.5 g jar
> are not the same measurement however similar the products look.

```bash
npm run verify:catalog
```

Repeat until:

```
READY — all N variant(s) can enter checkout
```

> **This is the step the rehearsal could not perform.** Production had no
> catalog, so no real product record has yet met the compliance matrix. This gate
> is the first and only place that risk is discovered. Treat a failure here as
> expected, not exceptional.

Only then, and **outside the maintenance window** if preferred:

```sql
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_compliance_matrix;
```

- [ ] Validation succeeded. (It takes SHARE UPDATE EXCLUSIVE — reads and writes
      continue.)

---

## 11. Final readiness

```bash
npm run verify:checkout-readiness
```

Expected:

```
Checkout readiness gate (read only)

  database fingerprint: <12 hex chars>
  expected migrations:  16

[1] Schema
  PASS  schema is at migration 16
  …
[5] Scheduler and configuration
  PASS  the expiry sweeper completed within 900s — 44s ago
  PASS  CRON_SECRET is configured
  PASS  checkout is still disabled during preflight

==========================================================
READY — 36 checks passed

Checkout may be enabled. Set CHECKOUT_ENABLED=true and redeploy.
==========================================================
```

- [ ] **READY, zero failures, exit code 0.** Checkout may not be enabled
      otherwise.

---

## 12. Enablement

- [ ] Set **`CHECKOUT_ENABLED=true`** in Vercel Production.
- [ ] Deploy.

Place **one controlled real order** and verify each step:

- [ ] Add to bag → Checkout → draft created; `reserved_quantity` increments.
- [ ] Review page totals are correct.
- [ ] Leave a second draft to expire; the cron releases it with no user
      activity; `reserved_quantity` returns.
- [ ] Place the order → status `placed`, `inventory_quantity` decrements,
      `reserved_quantity` returns.
- [ ] `payments` row is `awaiting_collection` for the exact total.
- [ ] Double-submit the placement → exactly one order.
- [ ] Cancel a test order → stock returns, payment `cancelled`, one
      `ORDER_CANCELLED` event; cancel again → reports success, stock unchanged.
- [ ] Collect cash and confirm government photo ID at handoff → `completed`,
      `AGE_VERIFIED_AT_HANDOFF` audited.
- [ ] Complete the pickup.

Then confirm, in the database:

- [ ] `inventory_quantity` / `reserved_quantity` correct on every variant touched.
- [ ] `order_events` has one row per transition; `current_status` matches the
      latest event.
- [ ] `payments` has one collected row, no duplicate open obligation.
- [ ] `fulfilments` records the store, handoff time, who handed off, ID checked.
- [ ] `audit_log` has `ORDER_PLACED`, `PAYMENT_COLLECTED`,
      `AGE_VERIFIED_AT_HANDOFF`.
- [ ] `order_lines` carry class, basis, value, unit, usable equivalent,
      concentrate grams, plant count, rule id and `calculation_version = 2`.

---

## 13. Emergency stop

**The fastest safe way to stop new checkout activity:**

1. Set **`CHECKOUT_ENABLED=false`** in Vercel Production.
2. **Redeploy.**

That is the whole procedure. It takes effect on the next request after the
deployment completes.

### What stops

- Draft creation.
- Order placement — including drafts created moments before the switch.

### What keeps working, and must not be touched

- Browsing, product pages, the bag.
- Sign-in, accounts, password recovery.
- **Existing order viewing.** A customer with a placed order still needs to see
  it.
- **Staff fulfilment** — preparing, ready, cancellation, cash collection, ID
  confirmation, pickup completion. An order already taken still has to be handed
  over.
- Admin pages, including the readiness reports.

### What NOT to do

- **Do not delete purchase limit rules.** The database refuses; the refusal is
  correct. An order cites the rule it was checked against.
- **Do not delete orders or order lines.** They are the financial and regulatory
  record.
- **Do not delete audit history.**
- **Do not attempt a schema rollback.** There are no down migrations, and 24
  enum values across four migrations cannot be removed. If the schema genuinely
  must go back, **restore the database** to the recorded restore point and
  accept the loss of everything written since.

### Prefer forward fixes

- A wrong purchase limit → publish a correction. The wrong one stays visible;
  that is the design.
- A wrong classification → correct it at `/admin/catalog/compliance`. Placed
  orders keep their own snapshots and are unaffected.
- A stuck scheduler → checkout blocks new drafts on its own after 900 s.
  Existing orders are unaffected. Fix the cron; nothing else is required.

---

## 14. Sign-off

| Step | Who | Date | Result |
| --- | --- | --- | --- |
| Attorney confirmation | | | |
| Restore point recorded | | | |
| Migrations 0008–0015 | | | |
| Sixteen journal rows confirmed | | | |
| Privilege hardening applied | | | |
| Application repointed to `cloudmarket_app` | | | |
| `verify:privileges` — every check PASS | | | |
| Application deployment (checkout disabled) | | | |
| Purchase limit rules published | | | |
| Catalog classified + `verify:catalog` READY | | | |
| `VALIDATE CONSTRAINT` | | | |
| `verify:checkout-readiness` READY | | | |
| `CHECKOUT_ENABLED=true` | | | |
| Controlled order verified | | | |
