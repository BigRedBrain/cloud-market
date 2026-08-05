# Phase 4 — Restored-Production Rehearsal

**Status: EXECUTED AND COMPLETE — 2026-08-05.**
Phase 4 merged to `main` as `fcc9e1e` (PR #1).
Attempts 1–3 were NO-GO to start. Attempt 4 ran the full sequence.

---

## 0. Recommendation

> ## 🟢 GO — apply migrations `0008`–`0015` to production
>
> **Conditional on two runbook defects being fixed first (F1, F2).** Both were
> found by this rehearsal, and either would have broken a real release part-way
> through.
>
> Every gate that can be satisfied before real catalog data exists **passed**:
>
> | | |
> | --- | --- |
> | Identity gates | **24 / 24** |
> | Migrations `0008`–`0015` | **applied**, 6927 ms, 0 lock waits |
> | Post-migration objects | **19 / 19** |
> | `verify:privileges` (restricted role) | **44 PASS, 0 FAIL** — twice |
> | Rule publication through `/admin/purchase-limits` | **10 / 10** |
> | Scheduler | **8 / 8** |
> | `verify:checkout-readiness` | **35 / 36** |
> | Order-lifecycle scenarios | **272 / 273** |
>
> ## 🔴 NO-GO — enabling checkout
>
> Not because anything failed, but because the two gates that authorise it
> **cannot yet be satisfied**: production has no catalog. That is the correct
> state of the release, not a defect, and the runbook already blocks on it.
>
> The one remaining readiness failure is `there are active variants to sell — 0`.
> The one remaining scenario failure is **F6**, a defect in a *test*, not in the
> product.

---

## 1. Identity gates — 24 / 24 PASS

Re-run immediately before any write, against the operator's shell. No connection
string, hostname, username, password or secret appears anywhere in this
document; identities are SHA-256 fingerprints, first 12 hex.

```
                        hostname-fp    endpoint-fp
DATABASE_URL            48d2998d7060   a53081efb29d
DATABASE_URL_UNPOOLED   033993dbfcb0   a53081efb29d
known production        2b968b3cbe06   (published live by /api/health)
known development       eec6912eb35b   a5d81ac199d8
```

| # | Gate | Result |
| --- | --- | --- |
| — | Both strings came from the operator's shell, not `.env.local` | **PASS** |
| 1 | The two URLs are one Neon endpoint | **PASS** — identical endpoint fp, `system_identifier`, database name, table set and applied-migration hashes |
| 2 | Not production `2b968b3cbe06` | **PASS** |
| 3 | Not development `eec6912eb35b` / `a5d81ac199d8` | **PASS** |
| 4 | Journal exactly 8 rows, `0000`–`0007` | **PASS** — every row's `created_at` maps to one repo entry |
| 5 | `orders` does not exist | **PASS** — all eight Phase 4 tables absent |
| 6 | `CHECKOUT_ENABLED=false` · `SEED_TARGET_ENVIRONMENT=staging` · `CRON_SECRET` present | **PASS** |

Re-confirmed before the second phase of work: target unchanged, still neither
production nor development, all three variables still correct.

### Branch isolation — proven vs attested

`NEON_API_KEY` and `VERCEL_TOKEN` are unset, so parentage cannot be read from the
Neon control plane.

**Proven technically:** the endpoint is neither production's nor development's;
the schema was at production's version (8 rows) while development is at 16; the
data shape was production's (0 catalog rows vs development's 43 variants); and
the journal was **inherited, not built here** — the recorded content hashes for
`0000` and `0004` do not match this repository's files while the other six do,
which is what a copy-on-write branch of an older production looks like and what a
freshly built database could not produce.

**Attested by the operator:** that the parent is specifically the production
branch, and that no Vercel deployment references the copy.

### Restore point — NOT taken

**This is the one documented precondition that could not be met.** Taking or
confirming a restore point of the copy needs the Neon control plane, and no API
key is available to this process. The rehearsal proceeded on the stated basis
that the copy is a disposable branch whose recovery path is delete-and-re-branch.
No step depended on being able to roll the copy back, and none was needed.

---

## 2. Results

### 2.1 Baseline

| Item | Value |
| --- | --- |
| Restore source | Neon child branch of production (operator-created) |
| Fingerprints | `48d2998d7060` pooled · `033993dbfcb0` direct · endpoint `a53081efb29d` |
| Distinct from live production | **Yes** — live publishes `2b968b3cbe06` |
| Journal rows at baseline | **8** (`0000`–`0007`) ✔ |
| Server | PostgreSQL 18.4 |
| Owner role | `neondb_owner`, **not** a superuser |
| Database size | 9560 kB |
| Extensions | `plpgsql` only — `btree_gist` **not** yet present |
| Total rows, whole database | **25** |

Aggregate counts at baseline: users **3** · stores **1** · audit_log **17** ·
sessions **2** · verification_tokens **2** · products **0** ·
product_variants **0** · carts **0** · cart_lines **0** · everything else **0**.

> **The catalog is empty.** This single fact governs §2.5, §2.7 and the NO-GO on
> enabling checkout.

### 2.2 Privilege separation

The runbook's §2 SQL was first probed **verbatim at the 0007 baseline, where the
runbook places it**, inside a transaction that was rolled back. Four of its ten
statements failed — see **F1**. It was then applied in the corrected position,
after migrations, where all ten succeed.

`npm run verify:privileges`, as `cloudmarket_app`, **run twice** — once
immediately after the role was established and again after rules were published:

```
  database fingerprint: 48d2998d7060
  connected as:         cloudmarket_app
==========================================================
ALL REQUIRED PRIVILEGES CORRECT — 44 PASS, 0 WARN
==========================================================
```

Both runs identical. Not a superuser; owns none of `purchase_limit_rules`,
`audit_log`, `order_events`; cannot disable either guard trigger; cannot replace
the guard function; cannot DELETE or TRUNCATE any compliance table; cannot write
any of the eleven frozen columns; **can** write the three mutable ones; cannot
touch `user_permissions` or create roles; the harness trigger-disable path is
unreachable.

### 2.3 Migrations

```
started   2026-08-05T19:47:15.775Z
finished  2026-08-05T19:47:22.702Z
total     6927 ms      exit code 0
journal   8 -> 16
```

Per-migration boundaries are not separately resolvable — `drizzle-kit` reports
one success for the batch, and every statement completed inside the 25 ms
sampling interval except two: a ~78 ms step in `0011` (the `btree_gist` region,
the only statement that waited on storage, `Extension:Neon/PS_ReadIO`) and a
~230 ms journal insert.

**Rows touched by the three rewriting operations: zero.**

| Migration | Rewrites | Before | After |
| --- | --- | --- | --- |
| 0011 GiST index build | `purchase_limit_rules` | did not exist | 0 |
| 0013 two `SET DATA TYPE` | `orders` | did not exist | 0 |
| 0014 cap columns | `purchase_limit_rules` | 0 | 0 |

The empty-database rehearsal measures 6865–6929 ms for the same range. This run
against a real copy of production measured **6927 ms** — inside that band,
because the data volume is identical: nothing.

### 2.4 Locks

Sampled every ~25 ms from a second connection. 63 samples, 47 distinct entries.
`AccessExclusiveLock` on `product_variants` present across ~4.3 s of the run;
`ShareRowExclusiveLock` / `RowShareLock` / `AccessShareLock` on `users`, `stores`
and `product_variants` across ~4.1 s; `ShareUpdateExclusiveLock` ~1.1 s; the rest
catalogue churn from enum and function work.

Figures are **first-to-last sighting** across the whole batch, not a
continuously-held duration for one statement.

**Lock waits: 0.** No sampled lock was ever ungranted. **This says nothing about
behaviour under concurrent live traffic** — it was measured in isolation.

### 2.5 Journal confirmed at 16, constraint confirmed NOT VALID

19 / 19 post-migration checks passed: all eight Phase 4 tables present; both
guard triggers enabled (`tgenabled='O'`); `purchase_limit_rules_no_overlap`
present (`contype=x`); `btree_gist` installed; `cannabis_class` 8 values,
`measurement_basis` 5, `admin_permission` 2, `audit_event` 38 → 58; the guard
function present.

`product_variants_compliance_matrix` is **present and `convalidated=false`** —
`NOT VALID`, as required. Re-confirmed at the end of the run. `VALIDATE
CONSTRAINT` was **not** run: validating an empty table proves nothing, and the
runbook correctly defers it until real catalog data passes readiness.

There are **no sequences** in the schema at either 0007 or 0015, so §2's
`GRANT … ON ALL SEQUENCES` is a no-op today.

### 2.6 Rule publication — through `/admin/purchase-limits` only

Published one class at a time through the admin screen, driven over HTTP exactly
as a browser without JavaScript would, **with the application running as the
restricted `cloudmarket_app` role**. The development seeder was never invoked.

| Check | Result |
| --- | --- |
| An `admin` **without** the grant is refused the page | **PASS** |
| `npm run perm … --grant=compliance_admin --confirm` succeeds | **PASS** — target endpoint `a53081efb29d` |
| The grant holder can open the page | **PASS** |
| Six classes published, each stored correctly | **PASS × 6** |
| Exactly one rule in force per class | **PASS** |

**10 PASS, 0 FAIL.** Each publish carried a written reason, a typed class
confirmation, the immutability acknowledgement and a password — step-up
re-authentication — and each recorded `published_by` and `reauthenticated_at`.

Values are the attorney-approved figures from `COMPLIANCE.md` §7:

| Class | v | Conversion | Basis | Usable cap | Conc | Plants |
| --- | --- | --- | --- | --- | --- | --- |
| `flower` | 1 | 1/1 | `net_weight_grams` | 70.87380781250 | 15 | 3 |
| `concentrate` | 1 | 1/1 | `net_weight_grams` | 70.87380781250 | 15 | 3 |
| `infused_solid` | 1 | 1/16 | `finished_net_weight_grams` | 70.87380781250 | 15 | 3 |
| `infused_liquid` | 1 | 45359237/57600000 | `finished_volume_fluid_ounces` | 70.87380781250 | 15 | 3 |
| `immature_plant` | 1 | 0/1 | `unit_count` | 70.87380781250 | 15 | 3 |
| `non_cannabis` | 1 | 0/1 | `exempt` | 70.87380781250 | 15 | 3 |

Audit rows written: `PERMISSION_GRANTED` 1, `COMPLIANCE_REAUTH_SUCCEEDED` 6,
`PURCHASE_LIMIT_RULE_PUBLISHED` 6.

> The exact ratios survived the round trip — `45359237/57600000` is stored as a
> ratio, not a decimal, which is the whole point of the field being two integers.

### 2.7 Restored catalog — real-data compatibility

```
  variants scanned:     0
  classes with a rule:  concentrate, flower, immature_plant,
                        infused_liquid, infused_solid, non_cannabis
  No variants to check. Production has no catalog yet — expected.
==========================================================
READY — all 0 variant(s) can enter checkout
==========================================================
```

Re-run with `--all`, which includes inactive and soft-deleted variants: **also
0**. The restored catalog is not merely empty of *active* products — it is empty
of products entirely.

**Real-data compatibility finding: no catalog type falls outside the approved
matrix, because the restored copy contains no catalog types at all.** There are
no `other`, `edible` or unclassified legacy rows to migrate, and no legacy
purchase-limit rows either — unlike development, which carries both.

**READY here means nothing was checked.** §2.7 was billed as the section most
likely to surface a real incompatibility. It surfaced none, and could not have.
The compliance-matrix risk is **deferred intact**, not retired.

### 2.8 Scheduler

Application run locally against the copy, as the restricted role, with
`CHECKOUT_ENABLED=false`. `/api/health` confirmed fingerprint `48d2998d7060`
before anything else.

| Check | Result |
| --- | --- |
| No credential → 401 | **PASS** |
| Wrong credential → 401 | **PASS** |
| Same-length wrong credential → 401 | **PASS** (constant-time, not a length check) |
| Authenticated sweep → 200 | **PASS** — `completed`, `expired=0`, 482 ms |
| `/api/health` `ageSeconds` under 180 | **PASS** — 1 s |
| A successful run is recorded | **PASS** |
| A second authenticated sweep also succeeds | **PASS** |

**8 PASS, 0 FAIL.** The sweep wrote its `scheduler_runs` row **as the restricted
role**, confirming that grant works in practice and not merely on paper.

### 2.9 Checkout readiness

```
  database fingerprint: 48d2998d7060
  expected migrations:  16
==========================================================
NOT READY — 35 passed, 1 failed
==========================================================
```

[1] Schema **8/8** · [2] Production role privileges **11/11** · [3] Purchase
limit rules **8/8** · [4] Catalog **5/6** · [5] Scheduler and configuration
**3/3** — including `the expiry sweeper completed within 900s — 12s ago`,
`CRON_SECRET is configured`, and `checkout is still disabled during preflight`.

**The single failure is `there are active variants to sell — 0`.** It is the
correct answer for a database with no catalog, and it is the gate doing its job.

Reaching this gate at all required **F2**.

The kill switch was verified independently: `checkoutGate()` returns
`{open: false, reason: 'disabled'}`, the customer sees *"Online ordering is not
open yet…"*, and the parser is strict — `1`, `yes`, `TRUE` and `True` all read as
**off**; only the literal `true` enables.

### 2.10 Order-lifecycle scenarios — 272 / 273

Run only after the prerequisite gates passed. The one outstanding readiness
failure is the absence of a real catalog, which these suites supply themselves as
isolated fixtures, removed by id afterwards.

| Suite | Result |
| --- | --- |
| `npm run test:sweeper` | **53 passed, 0 failed** |
| `npm run test:concurrency` | **28 passed, 0 failed** |
| `npm run test:governance` | **103 passed, 1 failed** — see **F6** |
| `npm run test:catalog-admin` | **88 passed, 0 failed** |

Covered across them: draft reservation; 15-minute expiry and automatic release
with no user activity; placement before expiry; placement racing expiry;
cancellation and release; cash collection; physical-ID confirmation; pickup
completion; rule change during an active draft; measurement correction during an
active draft; unclassified product refusal; the scheduler going stale and
recovering; existing-order access while checkout is disabled; bounded batches;
overlapping invocations standing down; and a failed run not advancing the
last-success signal.

Before rules were published, `test:sweeper` failed at `draft created` — draft
creation resolves a rule in force and the copy had none. After §2.6 it passes
completely. **That dependency is itself a result: on a database with no published
rules, no draft can be created at all.**

### 2.11 Data cleanup — and what cannot be cleaned

| Item | Outcome |
| --- | --- |
| `test:sweeper`, `test:concurrency`, `test:governance`, `test:catalog-admin` fixtures | removed by the suites, by id — each verified its own teardown |
| Earlier `scheduler_runs` rows | removed by captured id |
| **6 published rules** | **cannot be removed** |
| **The rehearsal officer** | **cannot be removed** |
| **Audit trail** (17 → 34 rows) | **cannot be removed** |

Probed and rolled back:

```
a published rule cannot be deleted
  23001: purchase_limit_rules is append-only: rule 6b6c63ef… may not be deleted

the rehearsal officer cannot be deleted
  23001: purchase_limit_rules is immutable: publish a new version
         instead of editing rule 6b6c63ef…
```

The second is the more interesting refusal: deleting the user cascades toward
`published_by`, and the **immutability** trigger stops it — not a foreign key.
The compliance record defends itself from the far end.

> **Therefore §2.11 cannot be completed by deleting rows, and the copy must be
> DELETED rather than reused or reset.** This is the correct behaviour and is a
> direct rehearsal of why production rule publication is one-way.

---

## 3. Findings

### F1 · §2 cannot run where §3 puts it — **blocks a real release**

`PHASE-4-RELEASE.md` §2 sits **before** §3, but four of its ten statements
reference tables that `0008`–`0015` have not yet created. Verbatim against a real
0007 production schema:

```
   1. OK    CREATE ROLE                       6. ERROR GRANT UPDATE(cols) …   42P01
   2. OK    GRANT USAGE ON SCHEMA             7. OK    REVOKE ON audit_log
   3. OK    GRANT ON ALL TABLES               8. ERROR REVOKE ON order_events 42P01
   4. OK    GRANT ON ALL SEQUENCES            9. ERROR REVOKE ON user_perms   42P01
   5. ERROR REVOKE ON purchase_limit_rules   10. OK    ALTER DEFAULT PRIVILEGES
           42P01 relation does not exist
```

Run as a script it **aborts at statement 5**, leaving a role with blanket
`SELECT, INSERT, UPDATE, DELETE` on every table, **none** of the compliance
REVOKEs, and no `ALTER DEFAULT PRIVILEGES`.

**Fix: move §2 wholesale to after §3 and before §4.** Verified — all ten then
succeed and `verify:privileges` returns 44 PASS / 0 FAIL. The ordering rationale
survives: the app role still cannot run migrations, and the application is not
deployed until §4 either way.

### F2 · §2 omits the grant §7 needs — **blocks a real release**

`npm run verify:checkout-readiness` aborts immediately as the application role:

```
[1] Schema

ABORTED: permission denied for schema drizzle
```

It reads `drizzle.__drizzle_migrations`; §2 grants only on `public`. **Running it
as the owner is not a fix** — the gate audits `current_user`, so the owner would
produce a false pass.

**Fix: add to §2.**

```sql
GRANT USAGE ON SCHEMA drizzle TO cloudmarket_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO cloudmarket_app;
```

Verified: the gate then runs to completion, and
`has_table_privilege('cloudmarket_app','drizzle.__drizzle_migrations','INSERT')`
remains **false**.

### F3 · The pre-migration gate cannot pass against a rehearsal copy

`verify-migration-target.mjs` check B anchors the target to the fingerprint the
*live production application* publishes — which a correctly isolated copy must
**not** match. Both runs returned NO-GO with check B as the sole objection, at
`--expect-migrations=8` and `=16`; checks A (same branch) and C (data signature)
passed both times.

**Fix:** add a `--rehearsal` flag that inverts check B to *must NOT match live*,
or document that only A and C apply to a copy. Do not train operators to read
past a NO-GO.

### F4 · §2.10's prerequisites — RESOLVED

Previously recorded as unexecutable: the scenarios need rules and catalog,
production supplies neither, and the seeder is forbidden.

**Resolved by publishing rehearsal-only rules through `/admin/purchase-limits`**
(§2.6) rather than through the seeder — which also rehearsed the grant, the
step-up re-authentication and the audit row, and is a better test than the
scenarios it unblocked. The catalog half remains supplied by suite fixtures.

**Recommend the runbook say so explicitly:** the rehearsal publishes rules
through the admin path on the copy, as its own step, before the scenarios.

### F5 · Two journal hashes do not match this repository — informational

The copy's recorded content hashes for `0000` and `0004` differ from the current
`drizzle/*.sql` files; the other six match. Both files have exactly one commit
and were never edited after it, so production was migrated from a working state
adjusted before commit.

**No action required.** `drizzle` selects migrations by `created_at` versus
`folderMillis`, never by hash (`node_modules/drizzle-orm/pg-core/dialect.cjs`).
All eight applied rows map cleanly to `0000`–`0007`, and `0008`–`0015` were
selected correctly.

Recorded because production's 0007 schema is therefore **not byte-identical** to
what this repository rebuilds, so `npm run rehearse:migration` tests a slightly
different starting schema than production actually has.

### F6 · A governance test is coupled to development's legacy rows — **test defect**

`npm run test:governance` fails one of 104 checks against a clean
production-lineage database:

```
FAIL  a class with no rule in force is REFUSED, not defaulted to zero — unsupported
```

`PROBE_CLASS` is `'other'`, and `resolveLimitRules` checks **supported-ness
before existence**:

```
resolveLimitRules(['other'])  -> { ok: false, reason: 'unsupported', classes: ['other'] }
resolveLimitRules(['edible']) -> { ok: false, reason: 'unsupported', classes: ['edible'] }
resolveLimitRules(['flower']) -> ok: true
```

The test asserts `reason === 'missing'`. It only reaches that branch when the
database has **no open `other` rule**, and it only passes when the database
**does** have one — development carries legacy open `other` and `edible` rows;
a copy of production carries none. So the assertion passes in development for an
incidental reason and fails here.

**The application is correct, and arguably more correct than the test:** it
refuses `other` as *unsupported*, which is a stronger and earlier refusal than
*missing*. Both fail closed. **No safety impact.**

**Fix the test, not the product** — assert `!ok` and that the class is named,
rather than pinning the exact reason; or use a supported class with no rule as
the probe.

---

## 4. What is proven, and what is still not

| Now proven, against production's own lineage | Evidence |
| --- | --- |
| `0008`–`0015` apply to production's **actual** 0007 schema | 6927 ms, exit 0, journal 8 → 16 |
| `btree_gist` installs under a non-superuser owner | present after 0011 |
| Every post-migration object is correct | 19 / 19 |
| The restricted role is correctly separated | 44 PASS, 0 FAIL, twice |
| Rules publish only through the guarded admin path | 10 / 10, with grant, step-up and audit |
| Exact ratios survive publication | `45359237/57600000` stored as integers |
| Compliance records defend themselves | rule DELETE and officer DELETE both refused by trigger |
| The scheduler authenticates, runs and records as the restricted role | 8 / 8 |
| The kill switch refuses and parses strictly | `1`, `yes`, `TRUE` all read as off |
| The order lifecycle works on this schema | 272 / 273 |

| Still not proven — only real production data can | Why it matters |
| --- | --- |
| Migration duration over real data | Nothing to measure. Re-measure if production is not empty when the window opens |
| Lock duration under concurrent load | Measured in isolation; zero waits proves nothing about live traffic |
| **Real catalog rows against the compliance matrix** | **The main open risk.** Deferred intact |
| Real inventory coherence | Nothing to check |
| Behaviour of real historical rows | The copy has 3 users, 1 store, 17 audit rows and nothing else |

---

## 5. Effect on the release

**Apply F1 and F2 to `PHASE-4-RELEASE.md` before the window.** Releasing against
the runbook as it stands would break at §2, before any migration ran.

With those applied, the migration step is cleared. This run confirms directly,
rather than by assumption, the premise §0 of the runbook already argued:
production has no orders, no rules and no catalog, so the three rewriting
operations touch nothing.

**The compliance-matrix question cannot be closed before launch and does not need
to be.** It is answered the first time real catalog data meets
`npm run verify:catalog`, which the release already requires to pass before
`VALIDATE CONSTRAINT` and before checkout is enabled. That ordering is correct
and is why this gap is tolerable.

### Corrected sequence

| Step | Command | Gate |
| --- | --- | --- |
| Pre-flight | `verify-migration-target.mjs --expect-migrations=8` | GO *(see F3 for copies)* |
| **Migrate** | `npx drizzle-kit migrate` | 16 journal rows |
| Confirm | `verify-migration-target.mjs --expect-migrations=16` | GO |
| **Privileges** | §2 SQL **+ the two `drizzle` grants (F2)** | all statements succeed |
| Audit | `npm run verify:privileges` | 44 PASS, 0 FAIL |
| Deploy | `CHECKOUT_ENABLED=false` | checkout refused |
| Rules | `/admin/purchase-limits`, by the named officer | one rule per class |
| Catalog | classify by hand, then `npm run verify:catalog` | READY |
| Validate | `ALTER TABLE product_variants VALIDATE CONSTRAINT …` | succeeds |
| Readiness | `npm run verify:checkout-readiness` | READY, exit 0 |
| Enable | `CHECKOUT_ENABLED=true` | one controlled real order |

`PHASE-4-RELEASE.md` remains the procedure. This document changes its **order**
(F1), adds **two grants** (F2), and qualifies **one gate** (F3).

---

## 6. Operator action required

- [ ] **Delete the rehearsal Neon branch** (endpoint `a53081efb29d`). It holds a
      copy of production's users and audit history, plus six published rules, a
      rehearsal officer and an audit trail that **cannot be deleted from inside
      the database**. It must not be reused or reset — only dropped.
- [ ] Apply **F1** and **F2** to `PHASE-4-RELEASE.md` before the release window.
- [ ] Fix **F6** in `scripts/verify-limit-governance.ts` (test-only).
- [ ] Consider **F3** and **F4** as documentation improvements.
