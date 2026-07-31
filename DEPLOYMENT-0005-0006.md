# Production rollout — migrations 0005 & 0006

Status: **not started.** Nothing has been pushed and nothing has been applied to
production. This document is the plan to be reviewed before either happens.

A first pre-flight attempt read the **development** database rather than
production and must be re-run. Production's migration state is still unverified.
The cause, and the tooling change that makes the mistake impossible to repeat,
are in §7a — read that before running Step 0.

---

## 1. What is being deployed

| Migration | Contents | Shape |
| --- | --- | --- |
| `0005_flimsy_shinko_yamashiro.sql` | `cart_status` enum; `carts` and `cart_lines` tables; 7 indexes (2 unique, one of them partial); `cart_lines_quantity_positive` CHECK | Purely additive. No existing table is altered. |
| `0006_normal_darwin.sql` | `ALTER TYPE audit_event ADD VALUE 'CART_MERGED'` | Purely additive. One enum label. |

Neither migration touches, rewrites, or locks an existing table. There is no
backfill, no column type change, and no data migration. Total expected duration
is under a second on a database this size.

Application code being deployed: the Phase 3 bag routes, `lib/bag/*`, and the
sign-in/sign-up merge call.

---

## 2. The ordering constraint, and why it is not optional

**Migration must land before code.** This is not a general preference; it is
specific and load-bearing here.

`getBagCount` is called by `/`, `/shop`, `/shop/[category]` and `/product/[slug]`
— every storefront page that renders the nav. Its behaviour splits on viewer:

```
findActiveBag(null)      → no bag cookie → returns before any query   ← safe
findActiveBag(userId)    → SELECT … FROM carts                        ← 42P01
```

So if the code ships first:

- **Anonymous visitors** are unaffected. No cookie exists yet in production
  (the cookie is only issued by a mutation, and no cart code has ever run
  there), so the query is never reached.
- **Every authenticated user** — including every admin — gets a **500** on `/`,
  `/shop`, `/shop/[category]`, `/product/[slug]` and `/bag`, because `carts`
  does not exist.
- **`/api/health` stays green.** It does not touch `carts`. Monitoring would
  show a healthy site while signed-in users saw errors.

`/admin` itself does not call `getBagCount`, so admin tooling would keep working
— which makes the failure quieter, not better.

Deploying migration-first has no symmetric risk: `carts` and `cart_lines` simply
sit unused by the currently-deployed code, which has no knowledge of them.

---

## 3. Sequence

Each step has an explicit gate. Do not proceed past a failed gate.

### Step 0 — Pre-flight (read-only)

This shell is **PowerShell**, which has no `VAR=value command` prefix. Set the
variable first:

```powershell
$env:DATABASE_URL = "<pooled production connection string>"
node scripts/verify-bag-production.mjs https://cloud-market-ten.vercel.app --allow-production --preflight
```

Use the **pooled** string here; the unpooled one is only for Step 2.

The script no longer reads `.env.local`, and it refuses to run unless the
database it connects to is the same one the deployed app reports at
`/api/health`. A first line reading `target confirmed` is what makes the rest of
the output trustworthy:

```
deployed app database:  2b968b3cbe06 (environment: production)
this script's database: 2b968b3cbe06
target confirmed: same database as the deployed application

PRE-FLIGHT: 0005 NOT APPLIED, 0006 NOT APPLIED
```

Prints no credentials. If the two fingerprints differ it aborts with exit 1 and
reads nothing.

**Gate:** `target confirmed` appears, and both migrations report NOT APPLIED.

### Step 1 — Snapshot for rollback

Create a Neon branch from production immediately before migrating. On Neon this
is copy-on-write and effectively instant:

```
Neon console → cloud-market → Branches → New branch
  from: production/main   name: pre-cart-0004-<date>
```

This is the rollback substrate for §5. Do not skip it because the migrations are
additive — the point is to be able to prove what the schema looked like, not
only to restore it.

**Gate:** branch exists and is visible in the console.

### Step 2 — Apply the migrations

Use the **unpooled** connection string. Drizzle migrations run DDL in a
transaction; a pooled connection can hand you a different backend mid-session.

```powershell
$env:DATABASE_URL = "<UNPOOLED production connection string>"
npx drizzle-kit migrate
```

Both files apply in one run, in order. `ALTER TYPE … ADD VALUE` is permitted
inside a transaction on Postgres 12+ provided the new value is not *used* in the
same transaction; 0006 only declares it, and the first row using `CART_MERGED`
is written later by application code. Neon runs Postgres 17.

**Gate:** the command reports success and exits 0.

### Step 3 — Confirm the schema landed

```powershell
$env:DATABASE_URL = "<pooled production connection string>"
node scripts/verify-bag-production.mjs https://cloud-market-ten.vercel.app --allow-production --preflight
```

Expected: `target confirmed`, then `PRE-FLIGHT: 0005 APPLIED, 0006 APPLIED`.

At this point production has cart tables and no cart code. The storefront is
unchanged and unaffected — nothing reads those tables yet. **This is a safe
resting point.** If the deploy has to wait a day, it can wait here.

**Gate:** both report APPLIED. `/api/health`, `/` and `/shop` still 200.

### Step 4 — Deploy the code

```bash
git push origin main
git push origin v0.9.0
```

Vercel auto-deploys `main` to production. The build runs `next build` only —
**no migration step runs during deploy**, which is why Steps 2 and 4 are separate
and ordered.

**Gate:** Vercel reports the deployment Ready.

### Step 5 — Verify

```powershell
$env:DATABASE_URL = "<pooled production connection string>"
node scripts/verify-bag-production.mjs https://cloud-market-ten.vercel.app --allow-production
```

Full run. See §6 for what it covers and §7 for what it deliberately does not.

**Gate:** 0 failed, and the residue section shows every count back to baseline.

---

## 4. Empty catalog, no seed data

Production has **0 products and 0 variants**, and none will be added by this
rollout. Consequences, all intentional:

- `/shop` renders its empty state. Unchanged by this deploy.
- There is nothing to add to a bag, so every production bag is empty and
  `/bag` renders its empty state for guests and customers alike.
- **No bag cookie will be issued in production** until a real product exists,
  because the cookie is only set by a mutation. The cookie's configuration is
  verified in the development suite (63 assertions) against identical code; in
  production it is unreachable until the catalog is populated.
- No seed will be run. The catalog is real business data and stays under the
  retailer's control.

The first real product added through `/admin` will exercise the bag path
naturally. That is the right first customer of this code, not a fixture.

---

## 5. Failure and rollback

| Failure | Blast radius | Response |
| --- | --- | --- |
| **Step 2 fails part-way** | None. DDL is transactional; a failed migration leaves the schema untouched. | Read the error. Do not deploy code. Re-run after fixing. |
| **0005 applied, 0006 fails** | None — no code is deployed yet. | Re-run `drizzle-kit migrate`; it resumes at 0006. |
| **Step 4 deploy fails to build** | None. Vercel keeps serving the previous deployment. | Fix and re-push. Schema stays ahead of code, which is the safe direction. |
| **Step 5 finds a functional bug** | Cart routes misbehave; the rest of the storefront is unaffected. | `vercel rollback` (or promote the prior deployment) to return to v0.8.0 code. **Leave the migrations in place** — additive tables are inert to code that does not know about them. |
| **Schema itself is wrong** | Requires the Step 1 branch. | Compare against `pre-cart-0004-<date>`. To undo: `DROP TABLE cart_lines; DROP TABLE carts; DROP TYPE cart_status;` then delete the two rows from `drizzle.__drizzle_migrations`. |

**The enum value cannot be dropped.** Postgres does not support removing a value
from an enum type. If `CART_MERGED` had to be reverted, the type would have to be
recreated and every dependent column rewritten. It is one inert label with no
rows referencing it, so the correct response to a problem is to leave it and stop
writing it — not to attempt a reversal that is far riskier than the thing it
undoes. This is the only genuinely one-way step in the rollout, and it is worth
being explicit that it is one-way before it happens.

**Rollback is asymmetric, and that is by design.** Code rolls back in seconds;
schema does not need to. Because both migrations are additive, the roll-forward
state (schema ahead of code) is always safe, and the roll-back state (code ahead
of schema) is the only dangerous one — which §2 exists to prevent.

---

## 6. What Step 5 verifies

| Requirement | How |
| --- | --- |
| `/api/health` healthy | Status, database reachability, `environment: production` |
| `/` healthy | 200, anonymous and authenticated |
| `/shop` healthy | 200, anonymous and authenticated |
| `/bag` loads for a guest | 200 + empty state renders |
| Empty bag renders correctly | Guest and authenticated |
| Authenticated bag loads | Temporary account, `/bag` 200 |
| Guest bag cookie | Asserted *not* issued by browsing; issuance needs a product (§7) |
| Add / update / remove | Rolled-back transaction against the production schema (§7) |
| Admin routes protected | `/admin`, `/admin/products`, `/admin/campaigns`, `/admin/media` deny anonymous; a customer is denied `/admin` |
| Auth regression | Sign-up, sign-in, sign-out, wrong-password rejection, no session on failure |
| Audit behaviour | `ACCOUNT_CREATED` and `LOGIN` written; IP and user-agent stored as 64-char hashes, never in clear |
| No residue | Nine tracked tables re-asserted against baseline counts, plus a search for probe rows by name |
| Old credentials rejected | See §8 |

---

## 7. What Step 5 deliberately does not do, and why

**It does not create a product.** Verifying add-to-bag over HTTP requires an
`active` product that `resolvePurchasableVariant` will accept — which is exactly
a product that is publicly visible on `/shop`. The storefront is ISR-cached for
60 seconds, so a fake cannabis product with a fake price and fake potency could
be served to real customers for up to a minute *after* it was deleted. Database
residue can be guaranteed zero; **cache residue cannot**, and on a licensed
Michigan retailer's storefront a visible fake product is a compliance question,
not a tidiness one. Making it `draft` to hide it would defeat the test, since a
draft variant is not purchasable by design.

So, per the brief's own instruction — *if zero residue cannot be guaranteed, do
not create one* — no product is created.

**What replaces it.** The cart write path runs against the real production schema
inside a transaction that is always rolled back, asserting: a line can be added;
the `least()` upsert sums then caps at stock (2+4 → 5); the upsert does not
duplicate; a duplicate `(cart_id, variant_id)` is rejected; `quantity = 0` is
rejected by the CHECK constraint; a second active cart for one user is rejected;
a line deletes cleanly; and a `CART_MERGED` audit row can be written. Residue is
impossible by construction rather than by cleanup code, and nothing is ever
visible to a customer because nothing is ever committed.

**What remains unverified in production:** the HTTP add/update/remove round trip
and guest cookie issuance. Both are covered by 63 assertions in `test:bag`
against identical code, and both will be exercised the first time a real product
is published. This is stated plainly rather than papered over.

**One temporary account is created.** Unlike a product it is invisible to other
visitors, and it is removed by primary key along with its sessions, carts and
audit rows, with baseline counts re-asserted afterwards.

---

## 7a. Incident: the pre-flight that read the wrong database

On the first attempt, Step 0 returned `0005 APPLIED, 0006 APPLIED` against what
was believed to be production. **It had read development.** No production
credential was ever used, and nothing was written anywhere.

Three defects lined up, all of them mine:

1. **The script loaded `.env.local` as a fallback.** That file holds development
   credentials. `dotenv` does not override an already-set variable, so passing
   `DATABASE_URL` inline worked — and omitting it failed silently instead of
   loudly.
2. **The documented command was bash syntax given to a PowerShell operator.**
   PowerShell has no `VAR=value command` prefix, so the variable never reached
   the process and the fallback in (1) took over.
3. **The plan told the operator to confirm a fingerprint the script could never
   print.** Two different schemes exist in this repo:

   | Scheme | Used by | Development | Production |
   | --- | --- | --- | --- |
   | `sha256(full hostname)` | `/api/health`, `verify-auth-production`, `verify-cms-production` | `eec6912eb35b` pooled / `3c503c1409d2` direct | `2b968b3cbe06` pooled |
   | `sha256(endpoint id)` | the original `verify-bag-production` | `a5d81ac199d8` (both) | — |

   The reported `a5d81ac199d8` was development under the second scheme, being
   compared against production under the first. Two different databases *and*
   two different algorithms.

What confirmed the diagnosis: the reported journal had 7 migrations with the most
recent at `2026-07-31T17:27:33.644Z`, which is exactly when 0006 was applied to
the development branch during Phase 3 — along with 20 public tables and the
seeded development catalog (12 products, 43 variants, 7 categories, 5 brands).
Production's catalog is empty.

**The fix, in the tool rather than in the instructions.** `verify-bag-production`
no longer reads `.env.local` at all, requires `DATABASE_URL` explicitly, and
before reading anything asks `/api/health` which database the deployed app is
using and refuses to continue unless its own connection resolves to the same
fingerprint under the same scheme. A wrong target now aborts with exit 1 instead
of producing a confident report. Both failure modes were tested: missing variable,
and development credentials aimed at the production URL.

**Production's migration state is therefore still unverified.** The assumption
that it sits at 0004 is unrefuted but also unconfirmed, and Step 0 must be run
again — correctly — before Step 2.

---

## 8. Credential hygiene during rollout

- Production connection strings are marked **Sensitive** in Vercel and cannot be
  retrieved with `vercel env pull` — the pulled file contains `[SENSITIVE]`
  placeholders. They must be supplied to the migration command from the operator's
  own environment.
- `.env.local` must stay on **development** throughout. Do not swap it to
  production to run the migration; pass `DATABASE_URL` inline on the command
  instead, so a later `npm run db:migrate` cannot hit production by accident.
  Verify with the fingerprint line the scripts print: development reads
  `a5d81ac199d8`, production reads `2b968b3cbe06`.
- After rollout, confirm the previously rotated production credential is still
  rejected. It should fail authentication at the database, not merely be unused.
- No script in this repo prints a username, password, or connection string.
  Every one of them prints a 12-character endpoint fingerprint instead.

---

## 9. Open item for the reviewer

Step 4 pushes `main`, which auto-deploys. If you would rather the deploy be
manual, disable auto-deploy for production in the Vercel project first, or push
to a staging branch and promote. The plan assumes auto-deploy stays on and that
Steps 2–3 have already completed, which makes the auto-deploy safe.
