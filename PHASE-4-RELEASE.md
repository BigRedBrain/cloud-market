# Phase 4 — Production Release Runbook

Commit `807cd50` (plus this review). Migrations **0008 → 0015**, forward only.

**Read the whole document before starting.** Steps are ordered because the order
is load-bearing: privileges before migrations, migrations before code, rules
before catalog, readiness before enablement.

> Every command shown is safe to run. No command in this runbook prints a
> credential. Where a connection string is needed it is set as an environment
> variable in the operator's own shell and never echoed.

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
  default owner has them. **If it fails the migration aborts — do not work
  around it by dropping the constraint.**
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

---

## 1. Before maintenance

- [ ] **Attorney has confirmed** the caps and the classification matrix
      ([COMPLIANCE.md](COMPLIANCE.md) §2, §7), including the two open items:
      whether `immature_plant` carries a usable-equivalent contribution, and
      whether any real product maps outside the matrix.
- [ ] **Vercel Pro or Enterprise confirmed**, *or* an approved external
      scheduler selected. Per-minute cron requires Pro/Enterprise; on Hobby
      `* * * * *` **fails the deployment** — it does not degrade to daily.
      If staying on Hobby, remove the `crons` entry from `vercel.json` and point
      the external scheduler at `/api/cron/sweep-drafts` at least every few
      minutes.
- [ ] **`CRON_SECRET` generated** (32+ random bytes) and set in Vercel
      **Production**, marked Sensitive.
- [ ] **Restore point confirmed** and its identifier recorded here: `__________`
- [ ] **`CHECKOUT_ENABLED` is unset or `false`** in Production.
- [ ] *(When credentials permit)* a **restored copy of production** prepared for
      rehearsal. `npm run rehearse:migration` proves the sequence applies from
      0007 but runs against an **empty** database — it says nothing about real
      data volume.

---

## 2. Database-owner steps

Run as the **owner**, before any migration.

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
```

> The column-level `GRANT UPDATE` **must** follow the table-level `REVOKE
> UPDATE`, not precede it. Reversed, the revoke removes the column grants too.

Then:

- [ ] Set Vercel Production `DATABASE_URL` to the **`cloudmarket_app`** string.
- [ ] Leave `DATABASE_URL_UNPOOLED` as the **owner** — migrations need it.
- [ ] Redeploy so the application picks up the new role.

```bash
$env:DATABASE_URL = "<production app connection string>"
npm run verify:privileges
```

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
==========================================================
ALL REQUIRED PRIVILEGES CORRECT — 44 PASS, 0 WARN
==========================================================
```

- [ ] **Every check PASS.** Do not proceed on any FAIL.
- [ ] Confirm the printed fingerprint matches `/api/health`.

---

## 3. Migration steps

```bash
# Record first
curl -s https://cloudmarket.cc/api/health
```

- [ ] Fingerprint recorded: `__________`
- [ ] Start time recorded: `__________`

```powershell
# In the SAME shell, immediately before migrating:
$env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"   # the OWNER
$env:PRODUCTION_POOLED_URL = "<production POOLED string>"

node scripts/verify-migration-target.mjs https://cloudmarket.cc `
  --expect-migrations=8 `
  --require-table=carts,cart_lines `
  --forbid-table=orders,user_permissions,scheduler_runs
```

**`--expect-migrations=8`, not 7.** The gate counts journal *rows*: `0000`
through `0007` is eight of them.

- [ ] Gate reports **GO**. On NO-GO, stop and read the reason.

```bash
npx drizzle-kit migrate
```

- [ ] Completion time recorded: `__________`
- [ ] Warnings recorded: `__________`

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

> **Do not publish limit rules during the migration.** Rules are published
> through the admin screen, by a named grant holder, after re-authentication —
> §5, not here.

---

## 4. Application deployment

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

## 5. Compliance setup

- [ ] Grant the named officer:

```bash
npm run perm -- --email=officer@example.com --list
npm run perm -- --email=officer@example.com --grant=compliance_admin \
  --reason="Named compliance officer, <board minute reference>" --confirm
```

- [ ] Publish **only attorney-approved values**, through
      `/admin/purchase-limits`, one class at a time, each with a reason and
      re-authentication.

> **Do not run `npm run db:seed:limits` against production.** It is the one
> script in this repository that can write to production, and its values are
> the CRA defaults pending confirmation, not an approval. Rule publication is
> **one way** — a wrong value can only be corrected by publishing another, and
> the wrong one stays on the record forever.

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

## 6. Catalog setup

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

Only then, and **outside the maintenance window** if preferred:

```sql
ALTER TABLE product_variants VALIDATE CONSTRAINT product_variants_compliance_matrix;
```

- [ ] Validation succeeded. (It takes SHARE UPDATE EXCLUSIVE — reads and writes
      continue.)

---

## 7. Final readiness

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

## 8. Enablement

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

## 9. Emergency stop

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

## 10. Sign-off

| Step | Who | Date | Result |
| --- | --- | --- | --- |
| Attorney confirmation | | | |
| Privilege hardening + `verify:privileges` | | | |
| Migrations 0008–0015 | | | |
| Application deployment (disabled) | | | |
| Purchase limit rules published | | | |
| Catalog classified + `verify:catalog` READY | | | |
| `VALIDATE CONSTRAINT` | | | |
| `verify:checkout-readiness` READY | | | |
| `CHECKOUT_ENABLED=true` | | | |
| Controlled order verified | | | |
