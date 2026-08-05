# Phase 4 — Restored-Production Rehearsal

**Status: NOT EXECUTED — NO-GO to start.**
Phase 4 merged to `main` as `fcc9e1e` (PR #1).
Assessment attempts: 2026-08-05 (attempt 1), 2026-08-05 (attempt 2, post-merge).

---

## 0. Verdict

> ## 🔴 NO-GO — the rehearsal cannot begin
>
> **This is not a NO-GO on the Phase 4 code**, which is merged. It is a NO-GO on
> *starting the rehearsal*, because the single precondition the rehearsal is
> defined by — **an isolated database restored from current production data** —
> is not reachable from this environment.
>
> No results are recorded below, because none were produced. Nothing in this
> document is an estimate, a projection or a substitute for a real run.

### Attempt 3 — 2026-08-05, after the rehearsal branch was reported created

A Neon child branch of production was reported created, with its pooled and
direct strings loaded as `DATABASE_URL` / `DATABASE_URL_UNPOOLED`, plus
`CHECKOUT_ENABLED=false`, `CRON_SECRET` and `SEED_TARGET_ENVIRONMENT=staging`.

**The local environment is unchanged.** `.env.local` was last written
**2026-07-31 23:19**, five days before this attempt, and still resolves to the
development database. None of the three rehearsal-only settings are present.

| Gate | Result | Evidence |
| --- | --- | --- |
| 1. Differs from production `2b968b3cbe06` | **PASS** | but only because it is development |
| 2. Not the normal development fingerprint | **FAIL** | `eec6912eb35b` / endpoint `a5d81ac199d8` — exactly development |
| 3. Baseline `0007`, eight journal rows | **FAIL** | **16** rows; the `orders` table already exists |
| 4. Isolated Neon child branch from production | **CANNOT ASSESS** | `NEON_API_KEY` unset — parentage unprovable |
| 5. Unreferenced by any Vercel deployment | **CANNOT ASSESS** | `VERCEL_TOKEN` unset |
| 6. Live application cannot reach it | **CANNOT ASSESS** | follows from 4 and 5 |

```
                      hostname-fp    endpoint-fp
DATABASE_URL          eec6912eb35b   a5d81ac199d8
DATABASE_URL_UNPOOLED 3c503c1409d2   a5d81ac199d8

CHECKOUT_ENABLED         not set
SEED_TARGET_ENVIRONMENT  not set
CRON_SECRET              unset
```

Gates 2 and 3 fail outright and 4–6 are unassessable, so **no write was
attempted**. Two independent facts each disqualify the target on their own: the
fingerprints are development's, and the schema is eight migrations past the
required baseline with the Phase 4 tables already present.

The likely cause is mechanical — the strings were copied but not saved to
`.env.local`, or were set in a different shell, a different env file, or in
Vercel rather than locally. This process reads `.env.local` and its own
environment, and neither carries them.

---

### Attempt 2 — post-merge, 2026-08-05

A Neon rehearsal branch was reported as created from production and its
credentials as configured locally. **They are not present in this environment.**

Every variable that could carry them was checked, by name, without printing any
value:

```
variable                          set   hostname-fp    endpoint-fp
DATABASE_URL                      yes   eec6912eb35b   a5d81ac199d8
DATABASE_URL_UNPOOLED             yes   3c503c1409d2   a5d81ac199d8
REHEARSAL_DATABASE_URL            no    -              -
REHEARSAL_DATABASE_URL_UNPOOLED   no    -              -
REHEARSAL_OWNER_URL               no    -              -
REHEARSAL_APP_URL                 no    -              -
PRODUCTION_POOLED_URL             no    -              -
STAGING_DATABASE_URL              no    -              -
NEON_API_KEY                      unset
```

`.env.local` holds eight variable names, of which the only two database entries
are `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. The raw process environment
contains no variable matching `DATABASE|NEON|REHEARS|STAGING|POSTGRES|PG|DB_`
beyond those. There is no second env file.

**The one reachable database is demonstrably not the rehearsal branch:**

| Evidence | Reading | Required of a rehearsal copy |
| --- | --- | --- |
| Hostname fingerprint | `eec6912eb35b` | must differ from development |
| Migration journal rows | **16** | **8** (baseline `0007`) |
| `product_variants` | 43 (development seed) | production's real catalog |
| `purchase_limit_rules` | 21 (development governance runs) | production's — none published |
| `orders` | 0 | production's real orders |

It is the development database, already fully migrated through `0015`. It is not
a copy of production and it is not at the `0007` baseline the rehearsal must
start from.

### Every step-2 gate is unperformable

| Required proof | Status |
| --- | --- |
| Fingerprint differs from production `2b968b3cbe06` | **cannot assess** — no rehearsal fingerprint exists |
| Originates from production as a branch or restore | **cannot assess** |
| Not referenced by any Vercel deployment | **cannot assess** |
| Not the normal development database | **cannot assess** |
| Live application cannot reach it | **cannot assess** |
| Baseline is `0007`, eight journal rows | **cannot assess** |
| Contents match production's data shape | **cannot assess** |

The brief's instruction is unambiguous: *stop with NO-GO if any identity or
isolation check is uncertain.* All seven are.

### What was deliberately NOT done

- **The development database was not substituted.** Running the sequence against
  it would produce timings, privilege results and scenario outcomes that look
  like a rehearsal and mean nothing — it holds no production data, and it is
  eight migrations past the baseline. That output would be worse than none,
  because it would read as evidence.
- **No production credential was sought**, and none is wanted here.
- **No migration was applied anywhere.**
- **No branch was provisioned** — `NEON_API_KEY` is unset, and provisioning
  production infrastructure is not this environment's to do.

### To unblock

Provide the rehearsal branch's connection strings in `.env.local`, or exported
in the shell, under names the rehearsal can find — two are needed:

```
REHEARSAL_OWNER_URL              # the branch OWNER — migrations, privilege SQL
REHEARSAL_DATABASE_URL           # the RESTRICTED app role, once created in step 4
```

The owner string is enough to begin: steps 2–5 create the restricted role, and
`verify:privileges` then runs against it. Everything else is ready; §4 of this
document lists the commands and their gates, and `PHASE-4-RELEASE.md` is the
procedure.

Once they are present, the first thing this rehearsal will do is re-run the
step-2 identity checks — including confirming the branch is at eight journal
rows and that its fingerprint is neither production's nor development's — and it
will stop again if any of them is uncertain.

### The stop condition that fired

From `PHASE-4-RELEASE.md` and the rehearsal brief:

> *Stop immediately and report NO-GO if … the restored database is not
> definitely isolated … [or] production and rehearsal credentials cannot be
> distinguished confidently.*

Both apply, for the same underlying reason: **there is no production credential
in this environment, and therefore no restored copy and nothing to distinguish.**

### What was checked, and what was found

| Capability required | Present | Consequence |
| --- | --- | --- |
| Production connection string | **No** | Cannot read production, cannot take a copy |
| `PRODUCTION_POOLED_URL` | **No** | Cannot even confirm production's identity |
| `NEON_API_KEY` | **No** | Cannot create a branch or a restore |
| `NEON_PROJECT_ID` | **No** | Cannot address the project |
| `VERCEL_TOKEN` | **No** | Cannot read the Sensitive production variables |

Reachable from here: the **development** database only.

```
DATABASE_URL fingerprint          eec6912eb35b   (development)
DATABASE_URL_UNPOOLED fingerprint 3c503c1409d2   (development, direct)
known production fingerprint      2b968b3cbe06
does any local string match production?   NO
```

Production credentials are marked Sensitive in Vercel and are deliberately not
exposed to this environment. That is the correct configuration and has been the
standing constraint since Phase 3. **It is not a defect to work around.**

### Why a substitute was not used

A rehearsal run against development, or against a synthetic dataset, would
answer a different question from the one asked. The whole point of a
*restored-production* rehearsal is production's **data volume and data shape**:
how long a table rewrite takes over real rows, and whether any real row violates
a constraint that an empty database never exercises.

Inventing that would be worse than not running it, because the output would look
like evidence. The earlier brief was explicit — *do not use invented staging
results as proof that production catalog data is correct* — and that applies
just as much to invented migration timings.

---

## 1. What HAS been proven, and what it does not cover

`npm run rehearse:migration` **has** been run, repeatedly, and passes. It is a
genuine result and is recorded here so it is not confused with the missing one.

```
REHEARSAL PASSED
  baseline 0000–0007      8113 ms
  production step 0008+   6865–6929 ms across runs
  final journal entries   16
```

Post-migration objects verified present: all six order tables,
`user_permissions`, `scheduler_runs`, both purchase-limit guard triggers enabled
(`tgenabled = 'O'`), the rule-overlap exclusion constraint, the catalog matrix
constraint, `btree_gist`, and the enum value counts (8 `cannabis_class`,
5 `measurement_basis`, 2 `admin_permission`).

**What that proves:** migrations 0008–0015 apply cleanly, in order, from
production's schema version, on a database built by their own predecessors. No
missing dependency, no unavailable extension, no statement that fails against
the state its predecessor leaves.

**What it does NOT prove, and only a restored copy can:**

| Unproven | Why it matters |
| --- | --- |
| Migration duration over real data | 0013 rewrites `orders`; 0014 rewrites `purchase_limit_rules`. Both are instant on an empty table. Production has no orders *today* — but this must be re-measured against whatever production actually holds when the window opens |
| Lock duration under concurrent load | Measured here in isolation. A rewrite holding ACCESS EXCLUSIVE behind live traffic behaves differently |
| Real catalog rows against the compliance matrix | 0015's constraint is `NOT VALID` so it will not fail — but `VALIDATE CONSTRAINT` later **will** if any real row violates it, and that is exactly what the readiness gate is for |
| Real inventory coherence | `verify:checkout-readiness` checks for negative or over-reserved counters; only real data can fail that |
| Behaviour of real historical rows | Production carries users, sessions, carts and audit history this rehearsal never created |

The isolation available to `rehearse:migration` is a **separate database on the
development endpoint** — isolated from the development database, not from the
development endpoint, and carrying no production data whatsoever.

---

## 2. Sections that require a real run

These are the report's required contents. Each is left **unfilled on purpose**.

### 2.1 Restored database baseline — NOT EXECUTED
- [ ] Restore source and point-in-time identifier: `__________`
- [ ] Restored-copy fingerprint: `__________`
- [ ] Confirmed **distinct** from the live production fingerprint: `__________`
- [ ] Journal rows at baseline — must be **8** (`0000`–`0007`): `__________`
- [ ] Representative row counts (users, products, variants, carts, audit): `__________`
- [ ] Confirmed unreachable by the live Vercel deployment: `__________`
- [ ] Restore point taken **of the copy itself**: `__________`

### 2.2 Migration durations — NOT EXECUTED
Per migration 0008 → 0015: start, end, duration, rows touched.

### 2.3 Locks observed — NOT EXECUTED
Measured, not derived. `pg_locks` sampled during the run.

### 2.4 Privilege verification — NOT EXECUTED
`npm run verify:privileges` against the **restricted** role on the copy.
Every check must PASS.

### 2.5 Catalog readiness — NOT EXECUTED
`npm run verify:catalog` against restored catalog rows. **This is the section
most likely to surface a real incompatibility**, because it is the first time
real product records meet the compliance matrix.

### 2.6 Scheduler — NOT EXECUTED
Rehearsal `CRON_SECRET`; 401 on missing and wrong credentials; an authenticated
sweep completing; `/api/health` reporting `ageSeconds` under 180.

### 2.7 Checkout readiness — NOT EXECUTED
`npm run verify:checkout-readiness`. Expected on a correctly prepared copy:
READY with zero failures — with `CHECKOUT_ENABLED` still false, which the gate
itself checks.

### 2.8 Scenario outcomes — NOT EXECUTED
Draft reservation · 15-minute expiry and automatic release · placement before
expiry · placement racing expiry · cancellation and release · cash collection ·
physical-ID confirmation · pickup completion · rule change during an active
draft · measurement correction during an active draft · unclassified product
refusal · scheduler going stale and recovering · existing-order access while
checkout is disabled.

After **each**: inventory and reserved counters, order status and inventory
state, order events, payment attempts, fulfilment records, purchase-limit rule
references, order-line compliance snapshots, audit events, scheduler run records.

> Every one of these thirteen scenarios is already covered by automated suites
> against development — `test:sweeper` (53), `test:catalog-admin` (88),
> `test:governance` (104), `test:concurrency` (28). The rehearsal's added value
> is running them against **real data shapes**, not re-proving the logic.

### 2.9 Data cleanup — NOT EXECUTED
Every row created during the rehearsal, removed by captured id. The copy itself
dropped when finished.

### 2.10 Production-data incompatibilities found — NOT EXECUTED
**Unknown.** This is the finding the rehearsal exists to produce, and its
absence is the reason for the NO-GO.

---

## 3. Exact remediation required

One thing unblocks this, and it needs a person with production access.

### Option A — Neon branch (preferred)

A Neon branch is copy-on-write from production, so it carries real data at real
volume and is isolated by construction.

1. Create a branch of the production Neon branch, named e.g. `rehearsal-YYYYMMDD`.
2. Confirm its endpoint fingerprint **differs** from production's.
3. Confirm no Vercel environment points at it.
4. Provide the operator running the rehearsal with:
   - the branch's **owner** connection string (for migrations and the privilege SQL)
   - `NEON_API_KEY` **or** a pre-created branch, so nothing has to be provisioned mid-run
5. Delete the branch when the rehearsal is complete.

### Option B — restored dump into an isolated database

1. `pg_dump` production, restore into a database no deployment can reach.
2. Confirm the fingerprint differs from production's.
3. Same credential handover as above.

### In both cases

- **The live production database is never the target.** Every script in this
  repository that can write refuses the production fingerprint, but the
  discipline is the operator's, not the tooling's.
- Set `SEED_TARGET_ENVIRONMENT=staging` for the rehearsal. The limit seeder will
  then run — **but do not use it**: step 10 of the release sequence requires the
  approved rule to be published through `/admin/purchase-limits`, exercising the
  grant, the re-authentication and the audit row, which is the point.
- Keep `CHECKOUT_ENABLED=false` for the entire rehearsal.

---

## 4. What is ready to run the moment a copy exists

Everything. No further code is required.

| Step | Command | Gate |
| --- | --- | --- |
| Baseline | `verify-migration-target.mjs --expect-migrations=8` | GO |
| Privileges | `npm run verify:privileges` | all PASS |
| Migrate | `npx drizzle-kit migrate` | 16 journal rows |
| Confirm | `verify-migration-target.mjs --expect-migrations=16` | GO |
| Catalog | `npm run verify:catalog` | READY |
| Readiness | `npm run verify:checkout-readiness` | READY, exit 0 |

The ordered procedure, the privilege SQL, the expected outputs and the emergency
stop are in **[PHASE-4-RELEASE.md](PHASE-4-RELEASE.md)**. This document adds
nothing procedural to it; the runbook is the procedure.

---

## 5. Effect on the release

**None of this blocks the merge.** The Phase 4 branch is complete, tested and
reviewed; merging changes nothing in production.

It blocks **step 3 of the release runbook — applying migrations to production**,
and only in the sense that the runbook's "before maintenance" checklist carries:

> *(When credentials permit)* a **restored copy of production** prepared for
> rehearsal.

Whether to proceed without it is a business decision, not a technical one, and
it should be taken with these facts in view:

**Arguments that the risk is currently low:** production has no orders, no
purchase limit rules and an empty-to-small catalog, so the three rewriting
operations touch almost nothing; the sequence is proven to apply from 0007; a
failed migration rolls itself back; and a restore point is taken beforehand.

**Arguments for waiting:** a restored copy is the only way to discover that a
real catalog row violates the compliance matrix *before* `VALIDATE CONSTRAINT`
is run against production; it is the only measurement of real lock duration; and
the cost of obtaining one is a single Neon branch.

**Recommendation: obtain the copy.** The blocker is one credential and a few
minutes of a person's time, against a migration sequence that is one-way past
twenty-four enum values.
