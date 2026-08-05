# Phase 4 — Restored-Production Rehearsal

**Status: EXECUTED — 2026-08-05.**
Phase 4 merged to `main` as `fcc9e1e` (PR #1).
Attempts 1–3 were NO-GO to start. Attempt 4 ran.

---

## 0. Verdict

> ## 🟡 The migration path is proven. The data-shape question is unanswerable today.
>
> Migrations `0008`–`0015` were applied to an isolated Neon child branch of
> production, carrying production's real schema lineage. They applied cleanly in
> **6927 ms** with **zero lock waits**, and every post-migration object check
> passed. The restricted application role was established and audited **44 PASS,
> 0 FAIL**. The scheduler was exercised end to end, **8 PASS, 0 FAIL**.
>
> **But the rehearsal's headline question — do real production rows survive the
> compliance matrix — has no answer, because production has no rows.** The
> restored copy carries 0 products, 0 variants, 0 purchase-limit rules and 0
> orders. There is nothing to test against. That is a fact about production, not
> a failure of this run.
>
> **Four defects were found in the release runbook.** Two of them would have
> stopped a production release part-way through. They are in §3.

---

## 1. Identity gates — all PASS

Re-run immediately before any write, against the credentials in the operator's
shell. No connection string, hostname, username, password or secret is printed
anywhere in this document; identities are SHA-256 fingerprints, first 12 hex.

```
                        hostname-fp    endpoint-fp
DATABASE_URL            48d2998d7060   a53081efb29d
DATABASE_URL_UNPOOLED   033993dbfcb0   a53081efb29d
known production        2b968b3cbe06   (published live by /api/health)
known development       eec6912eb35b   a5d81ac199d8
```

| # | Gate | Result | How it was proved |
| --- | --- | --- | --- |
| — | Both strings came from the operator's shell, not `.env.local` | **PASS** | raw `process.env` snapshotted before any dotenv load; values identical after |
| 1 | The two URLs are one Neon endpoint | **PASS** | endpoint fp identical; **and** identical `system_identifier`, database name, table set and applied-migration hashes read through both |
| 2 | Not production `2b968b3cbe06` | **PASS** | neither hostname matches; live `/api/health` publishes `2b968b3cbe06`, target is `48d2998d7060` |
| 3 | Not development `eec6912eb35b` / `a5d81ac199d8` | **PASS** | all four comparisons differ |
| 4 | Journal has exactly 8 rows, `0000`–`0007` | **PASS** | 8 rows; each row's `created_at` maps to exactly one repo journal entry, and all of `0000`–`0007` are present |
| 5 | `orders` does not exist | **PASS** | absent, as were all eight Phase 4 tables |
| 6 | `CHECKOUT_ENABLED=false`, `SEED_TARGET_ENVIRONMENT=staging`, `CRON_SECRET` present | **PASS** | all three read from the raw process environment |

24 checks, 24 PASS. Only then was anything written.

### Branch isolation — what is proven, and what is attested

`NEON_API_KEY` and `VERCEL_TOKEN` are both unset, so parentage cannot be read
from the Neon control plane. The distinction is kept explicit:

**Proven technically, from the database itself:**

- The endpoint (`a53081efb29d`) is neither production's nor development's.
- The schema is at exactly production's migration version (8 rows) while
  development is at 16 — so it is not development.
- The data shape is production's: 3 users, 1 store, 17 audit rows, **0 products,
  0 variants, 0 carts**. Development carries 43 variants and 21 rules.
- **The journal was inherited, not built here.** The recorded content hashes for
  `0000` and `0004` do not match this repository's current SQL files, while the
  other six do. A database freshly built from this repo would match all eight.
  This one carries a migration history it did not create locally — exactly what
  a copy-on-write branch of an older production looks like.

**Attested by the operator, not verifiable from here:** that the branch's parent
is specifically the production branch, and that no Vercel deployment references
it. The live application publishes `2b968b3cbe06` and the copy is `48d2998d7060`,
which is consistent with the second claim but does not prove it.

---

## 2. Results

### 2.1 Restored database baseline

| Item | Value |
| --- | --- |
| Restore source | Neon child branch of production (operator-created) |
| Restored-copy fingerprint | `48d2998d7060` pooled · `033993dbfcb0` direct · endpoint `a53081efb29d` |
| Distinct from live production | **Yes** — live publishes `2b968b3cbe06` |
| Journal rows at baseline | **8** (`0000`–`0007`) ✔ |
| Server | PostgreSQL 18.4 |
| Owner role | `neondb_owner`, **not** a superuser |
| Database size | 9560 kB |
| Extensions | `plpgsql` only — `btree_gist` **not** yet present |
| Representative row counts | users **3** · stores **1** · audit_log **17** · sessions **2** · verification_tokens **2** · products **0** · product_variants **0** · carts **0** · cart_lines **0** |
| Restore point of the copy itself | **Not taken** — needs the Neon API, which is unavailable here. The copy is a disposable branch; recovery is to delete and re-branch. |

> **The catalog is empty.** This is the single most consequential fact in this
> report and everything in §2.5 and §2.8 follows from it.

### 2.2 Migration durations

Applied with the documented command, `npx drizzle-kit migrate`, resolving through
`DATABASE_URL_UNPOOLED` (the branch owner).

```
started   2026-08-05T19:47:15.775Z
finished  2026-08-05T19:47:22.702Z
total     6927 ms      exit code 0
journal   8 -> 16
```

Per-migration boundaries are not separately resolvable: `drizzle-kit` reports one
success for the batch, and every individual statement completed inside the 25 ms
sampling interval except two — one ~78 ms step in `0011` (the `btree_gist`
region, the only statement that waited on storage: `Extension:Neon/PS_ReadIO`)
and a ~230 ms journal insert.

**Rows touched by the three rewriting operations: zero.**

| Migration | Rewrites | Rows before | Rows after |
| --- | --- | --- | --- |
| 0011 GiST index build | `purchase_limit_rules` | table did not exist | 0 |
| 0013 two `SET DATA TYPE` | `orders` | table did not exist | 0 |
| 0014 cap columns | `purchase_limit_rules` | 0 | 0 |

The empty-database rehearsal (§4) measured 6865–6929 ms for the same range. This
run against a real copy of production measured **6927 ms** — inside that band,
because the data volume is identical: nothing.

**This is the finding, stated plainly: a restored copy of production migrates in
the same time as an empty database, because production is empty.**

### 2.3 Locks observed

Sampled from a second connection every ~25 ms throughout the run, from `pg_locks`
joined to `pg_class`. 63 samples, 47 distinct lock entries.

| Lock | On | Observed |
| --- | --- | --- |
| `AccessExclusiveLock` | `product_variants` | present across ~4.3 s of the run |
| `ShareRowExclusiveLock` / `RowShareLock` / `AccessShareLock` | `users`, `stores`, `product_variants` | present across ~4.1 s |
| `ShareUpdateExclusiveLock` | (relation) | ~1.1 s |
| `RowExclusiveLock` | `pg_proc`, `pg_depend`, `pg_description`, `pg_class`, `pg_amop`, `pg_opclass` | catalogue churn from the enum and function work |

> Figures are **first-to-last sighting** of a lock entry across the whole batch,
> not a continuously-held duration for one statement. They bound the window in
> which the lock was present.

**Lock waits: 0.** No sampled lock was ever ungranted.

**This does not answer the concurrency question.** It was measured in isolation
with no other client connected. A rewrite holding ACCESS EXCLUSIVE behind live
traffic behaves differently, and this run says nothing about that.

### 2.4 Privilege verification

The restricted role was created with the runbook's §2 SQL, in the **corrected
position** — after §3, not before it (see finding **F1**). All ten statements
then succeeded and were committed.

`npm run verify:privileges`, run as `cloudmarket_app` against the copy:

```
  database fingerprint: 48d2998d7060
  connected as:         cloudmarket_app

==========================================================
ALL REQUIRED PRIVILEGES CORRECT — 44 PASS, 0 WARN
==========================================================
```

Every section passed: not a superuser; owns none of `purchase_limit_rules`,
`audit_log`, `order_events`; cannot disable either guard trigger; cannot replace
the guard function; cannot DELETE or TRUNCATE any compliance table; cannot write
any of the eleven frozen columns; **can** write the three mutable ones and do its
job; cannot touch `user_permissions` or create roles; the harness trigger-disable
path is unreachable; the overlap exclusion constraint is present.

This matches the runbook's documented expected output exactly.

### 2.5 Catalog readiness — vacuous

```
  variants scanned:     0
  classes with a rule:  NONE
  No variants to check. Production has no catalog yet — expected.
==========================================================
READY — all 0 variant(s) can enter checkout
==========================================================
```

**READY here means nothing was checked.** §2.5 was billed as *the section most
likely to surface a real incompatibility*, because it is the first time real
product records meet the compliance matrix. **No real product record exists.**

The `product_variants_compliance_matrix` constraint is in place and `NOT VALID`,
so it binds every future INSERT and UPDATE. `VALIDATE CONSTRAINT` was **not** run
— validating an empty table proves nothing, and the runbook correctly defers it
until after real catalog data passes readiness.

**The compliance-matrix risk is not retired. It is deferred, intact, to whenever
production's first real catalog is loaded.**

### 2.6 Scheduler

The application was run locally against the copy, as the restricted role, with
`CHECKOUT_ENABLED=false`. `/api/health` confirmed fingerprint `48d2998d7060`
before anything else was done.

| Check | Result |
| --- | --- |
| No credential → 401 | **PASS** |
| Wrong credential → 401 | **PASS** |
| Same-length wrong credential → 401 | **PASS** (constant-time path, not a length check) |
| Authenticated sweep → 200 | **PASS** — `outcome=completed`, `expired=0`, `durationMs=250` |
| `/api/health` `ageSeconds` under 180 | **PASS** — 1 s |
| A successful run is recorded | **PASS** |
| A second authenticated sweep also succeeds | **PASS** |

**8 PASS, 0 FAIL.** The sweep wrote its `scheduler_runs` row **as the restricted
role**, which confirms that grant is correct in practice and not merely on paper.

### 2.7 Checkout readiness

```
  database fingerprint: 48d2998d7060
  expected migrations:  16
==========================================================
NOT READY — 29 passed, 7 failed
==========================================================
```

All 7 failures are **expected states of a release that has not reached §5 or §6
yet**, not defects:

| Failing check | Why |
| --- | --- |
| exactly one rule in force × 6 classes | §5 has not run — rules are published by a named officer through the admin screen |
| there are active variants to sell | §6 has not run — and production has no catalog to load |

Sections [1] Schema (8/8) and [2] Production role privileges (11/11) passed
fully. [5] Scheduler and configuration passed fully once the sweeper had run:
`the expiry sweeper completed within 900s — 18s ago`, `CRON_SECRET is
configured`, `checkout is still disabled during preflight`.

**Reaching this gate at all required a fix — see finding F2.**

### 2.8 Scenario outcomes — NOT EXECUTABLE

The thirteen scenarios could not be run against the restored copy.

Both suites that drive them stop on a missing precondition that a copy of
production cannot supply:

- `npm run test:sweeper` — **1 passed, 2 failed**. It fails at `draft created`,
  because draft creation queries `purchase_limit_rules` for a rule in force and
  the copy has none. (Its teardown also throws on
  `select id from scheduler_runs where id in ('')` — a harness bug, unrelated to
  this release.)
- `node scripts/verify-limit-admin-http.mjs` — **47 passed, 9 failed**, against a
  real production build. Every one of the 9 is downstream of the same two absent
  preconditions: *a variant exists to attempt a classification against* (there
  are none) and *there is a rule to supersede* (there are none). The seven that
  follow — version incremented, points back at what it replaced, the previous
  version points at its successor, the supersession was audited, the page shows
  the superseded version, the pre-existing rule is open again, no dangling
  successor — are all assertions about superseding a rule that never existed.

**What those 47 passes do prove, on production's own schema:** the admin
authorization surface refuses unauthorised callers at the Server Action, not just
the page; a real publish stores the cap, the exact conversion, the measurement
basis and the plant cap; the publisher, the written reason and the
re-authentication instant are all recorded; the publish, the successful step-up,
the failed step-up and every refused attempt are audited; both guard triggers are
re-enabled afterwards; and every fixture row is removed by id, leaving *the rule
table exactly as it was found*.

**Why this was not worked around.** Manufacturing rules with
`npm run db:seed:limits:dev` would have unblocked both suites —
`SEED_TARGET_ENVIRONMENT=staging` is set, so the seeder would run. It was not
used, because §3 of this document forbids it and the reason still holds: the
publication path *is* the thing under test, and seeding bypasses the grant, the
step-up, the typed confirmation, the reason and the audit row.

That leaves a genuine contradiction in the plan, recorded as finding **F4**.

### 2.9 Data cleanup

| Item | Action |
| --- | --- |
| `scheduler_runs` × 2 (`c2577ac4…`, `5f2eabc9…`) | deleted by captured id; table back to 0 |
| `test:sweeper` fixtures | removed by the suite; `every fixture user was removed by id` passed |
| `verify-limit-admin-http` fixtures | removed by the suite; `the rule table is exactly as it was found` passed |

Every table that existed at the baseline is back at its **exact** baseline count
— users 3, stores 1, audit_log 17, sessions 2, verification_tokens 2, catalog 0.
All eight new Phase 4 tables are present and empty.

Remaining on the copy, deliberately: the `cloudmarket_app` role, the migrated
schema at 16, and the two extra `drizzle` grants from F2.

**The copy itself has NOT been dropped** — that needs the Neon console or API and
is the operator's step. It should be deleted now that this run is complete.

### 2.10 Production-data incompatibilities found

**None — and none could have been found.** Production carries no catalog rows, no
purchase-limit rules and no orders, so there is no production data capable of
being incompatible with anything.

This is a real answer, not a blank. It means the data-shape risk this rehearsal
existed to retire **does not currently exist**, and will not exist until real
catalog data is loaded — at which point `npm run verify:catalog` is the gate that
catches it, before `VALIDATE CONSTRAINT` is ever run.

---

## 3. Findings — required changes to the runbook

### F1 · §2 cannot run where §3 puts it — **blocks a real release**

`PHASE-4-RELEASE.md` §2 is placed **before** §3, but four of its ten statements
reference tables that migrations `0008`–`0015` have not yet created. Run verbatim
against a real 0007 production schema:

```
   1. OK    CREATE ROLE
   2. OK    GRANT USAGE ON SCHEMA
   3. OK    GRANT ON ALL TABLES
   4. OK    GRANT ON ALL SEQUENCES
   5. ERROR REVOKE ON purchase_limit_rules   42P01 relation does not exist
   6. ERROR GRANT UPDATE(cols) …             42P01
   7. OK    REVOKE ON audit_log
   8. ERROR REVOKE ON order_events           42P01
   9. ERROR REVOKE ON user_permissions       42P01
  10. OK    ALTER DEFAULT PRIVILEGES
```

*(Probed inside a transaction that was rolled back — nothing was committed.)*

Run as a script the block **aborts at statement 5**. The operator is left with a
role holding blanket `SELECT, INSERT, UPDATE, DELETE` on every table and **none**
of the compliance REVOKEs — the precise protection the whole design rests on —
and no `ALTER DEFAULT PRIVILEGES` either. `verify:privileges` would then fail, at
a point in the release where migrations have not yet been applied.

**Fix: move §2 wholesale to after §3 and before §4.** Verified on the copy — all
ten statements then succeed, and `verify:privileges` returns 44 PASS / 0 FAIL.
The ordering rationale still holds: the app role must not be able to run
migrations, and the application is not deployed until §4 either way.

*Note:* `GRANT … ON ALL SEQUENCES` is a no-op today — the schema has no sequences
at either 0007 or 0015.

### F2 · §2 omits the grant that §7 needs — **blocks a real release**

`npm run verify:checkout-readiness` aborts immediately when run as the
application role:

```
[1] Schema

ABORTED: permission denied for schema drizzle
```

It reads `drizzle.__drizzle_migrations`, and §2 grants only on schema `public`.
This is not avoidable by running it as the owner: the gate deliberately audits
`current_user`'s privileges, so running it as the owner would report the owner's
rights and produce a **false pass** — the exact failure mode this repository
warns about elsewhere.

**Fix: add to §2.**

```sql
GRANT USAGE ON SCHEMA drizzle TO cloudmarket_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO cloudmarket_app;
```

Read-only, on migration metadata only. Verified on the copy: the gate then runs
to completion, and `has_table_privilege('cloudmarket_app','drizzle.__drizzle_migrations','INSERT')`
remains **false**.

### F3 · The documented pre-migration gate cannot pass against a rehearsal copy

§4 of this document lists `verify-migration-target.mjs --expect-migrations=8`
with an expected result of **GO**. It cannot return GO against a rehearsal copy,
by construction. Its check B anchors the target to the fingerprint the *live
production application* publishes at `/api/health` — which a correctly isolated
copy must **not** match.

Both runs against the copy returned NO-GO, with check B as the sole objection:

```
[2] A — same branch as the pooled string?   YES
[3] B — matches the deployed application?   NO   <- sole objection
[4] C — data signature                      8 migrations, catalog empty,
                                            carts present, orders absent
```

Checks A and C — the substantive ones — passed at both `--expect-migrations=8`
and `=16`.

**Fix:** either give the script a `--rehearsal` flag that replaces check B with
"must NOT match the live fingerprint", or state in §4 that against a copy only
checks A and C apply and B is expected to object. Do **not** let an operator
learn to read past a NO-GO.

### F4 · §2.8 is unexecutable as specified

§2.8 requires the thirteen scenarios to run against restored production data.
They require purchase-limit rules and catalog variants. Production supplies
neither, and §3 forbids manufacturing them with the seeder. The three
requirements cannot all be satisfied at once.

**Fix: decide which of these §2.8 means, and say so.**

- **(a)** Run the scenarios against seeded fixtures *on the restored copy*,
  accepting that they prove the logic against production's **schema lineage**
  rather than its data. Honest, achievable today, and worth something — the
  47 passing checks in §2.8 are exactly this.
- **(b)** Defer §2.8 until production has real catalog data, and re-run the
  rehearsal then. This is when it would actually be informative.

Recommendation: **(b)**, with (a) noted as already done to the extent possible.

### F5 · Two journal hashes do not match this repository — informational

The copy's recorded content hashes for `0000` and `0004` differ from the current
`drizzle/*.sql` files; the other six match. Both files have exactly one commit
each and have never been edited since, so production was migrated from a working
state that was later adjusted before commit.

**No action required, and it did not affect this run.** `drizzle` selects
migrations by `created_at` versus the journal's `folderMillis`, never by hash —
confirmed in `node_modules/drizzle-orm/pg-core/dialect.cjs`. All eight applied
rows map cleanly onto `0000`–`0007` by timestamp, and `0008`–`0015` were selected
and applied correctly.

It is recorded because it means **production's schema at 0007 is not
byte-identical to what this repository's migrations would build**, so
`npm run rehearse:migration` (which builds from the current files) is testing a
very slightly different starting schema. Nothing surfaced here, but a future
migration that depends on the exact shape of something defined in `0000` or
`0004` would be worth checking against a real copy rather than a rebuilt one.

---

## 4. What HAS been proven, and what it does not cover

`npm run rehearse:migration` builds `0000`–`0007` from the current files on an
isolated database and applies `0008`+ to it. It passes, repeatedly:

```
REHEARSAL PASSED
  baseline 0000–0007      8113 ms
  production step 0008+   6865–6929 ms across runs
  final journal entries   16
```

This run adds to it, against production's own lineage rather than a rebuild:

| Now proven | Evidence |
| --- | --- |
| `0008`–`0015` apply to **production's actual 0007 schema** | 6927 ms, exit 0, journal 8 → 16 |
| `btree_gist` installs under `neondb_owner` (not a superuser) | present after 0011; the only storage-waiting statement in the run |
| Every post-migration object is correct | 19/19 — 8 tables, both guard triggers `tgenabled='O'`, the overlap EXCLUDE constraint, the compliance matrix present and `NOT VALID`, `cannabis_class` 8 / `measurement_basis` 5 / `admin_permission` 2, `audit_event` 38 → 58 |
| The restricted role is correctly separated | 44 PASS, 0 FAIL, audited as that role |
| The scheduler authenticates, runs, and records — as the restricted role | 8 PASS, 0 FAIL |
| The checkout kill switch refuses, and parses strictly | `checkoutGate()` → `{open:false, reason:'disabled'}`; `1`, `yes`, `TRUE`, `True` all read as **off** |
| The admin publication path works on this schema | 47 passing checks, including step-up re-auth and the audit rows |

Still **not** covered, and only real production data can cover it:

| Unproven | Why it matters |
| --- | --- |
| Migration duration over real data | Still unmeasured — there is no real data. Re-measure if production is not empty when the window opens |
| Lock duration under concurrent load | Measured in isolation; zero waits proves nothing about live traffic |
| Real catalog rows against the compliance matrix | **The main open risk.** Deferred intact until a real catalog exists |
| Real inventory coherence | Nothing to check |
| Behaviour of real historical rows | The copy has 3 users, 1 store, 17 audit rows and nothing else |

---

## 5. Effect on the release

**The migration step is cleared to proceed**, on the evidence above, subject to
**F1 and F2 being applied to the runbook first**. Releasing against the runbook
as it stands today would break at §2, before any migration ran.

The residual risk is unchanged from what §0 of `PHASE-4-RELEASE.md` already
argued, and this run confirms its premise directly rather than by assumption:
production has no orders, no rules and no catalog, so the three rewriting
operations touch nothing.

**The compliance-matrix question remains open and cannot be closed before
launch.** It will be answered the first time real catalog data meets
`npm run verify:catalog`, which is a gate the release already requires to pass
before `VALIDATE CONSTRAINT` and before checkout is enabled. That ordering is
correct and is the reason this gap is tolerable.

### Sequence to run, corrected

| Step | Command | Gate |
| --- | --- | --- |
| Pre-flight | `verify-migration-target.mjs --expect-migrations=8` | GO *(against production; see F3 for copies)* |
| **Migrate** | `npx drizzle-kit migrate` | 16 journal rows |
| Confirm | `verify-migration-target.mjs --expect-migrations=16` | GO |
| **Privileges** | §2 SQL **+ the two `drizzle` grants (F2)** | all statements succeed |
| Audit | `npm run verify:privileges` | 44 PASS, 0 FAIL |
| Deploy | `CHECKOUT_ENABLED=false` | checkout refused |
| Rules | `/admin/purchase-limits`, by the named officer | one rule per class |
| Catalog | classify by hand, then `npm run verify:catalog` | READY |
| Validate | `ALTER TABLE product_variants VALIDATE CONSTRAINT …` | succeeds |
| Readiness | `npm run verify:checkout-readiness` | READY, exit 0 |

`PHASE-4-RELEASE.md` remains the procedure. This document changes its **order**
(F1), adds **two grants** (F2), and qualifies **one gate** (F3).

---

## 6. Operator action required

- [ ] **Delete the rehearsal Neon branch** (`a53081efb29d`) — it holds a copy of
      production's users and audit history and is no longer needed.
- [ ] Apply **F1** and **F2** to `PHASE-4-RELEASE.md` before the release window.
- [ ] Decide **F4** — whether §2.8 is deferred until real catalog data exists.
