# Incident — the production verifier deleted two pre-existing audit rows

**Date:** 2026-07-31 · **Severity:** low impact, high principle · **Status:** CLOSED.
Fixed, regression-tested, and confirmed in production: the re-run recorded and
protected 1 pre-existing audit row, tracked and removed the 5 rows it created,
and returned audit_log exactly to baseline.

Recorded as a verification-harness incident. It did **not** block Phase 3
closure. The two rows deleted on 2026-07-31 remain unrecovered pending a
decision on §4 — the recovery plan there is still valid and unexecuted.

Production `audit_log` went from **2 rows to 0** during the full post-deployment
verification. Two rows that existed before the run were destroyed.

---

## 1. The bug

`scripts/verify-bag-production.mjs`, teardown, as shipped:

```js
if (userId) {
  await sql(`delete from cart_lines where cart_id in (select id from carts where user_id=$1)`, [userId])
  await sql(`delete from carts where user_id=$1`, [userId])
  await sql(`delete from audit_log where user_id=$1`, [userId])
  await sql(`delete from sessions where user_id=$1`, [userId])
  await sql(`delete from users where id=$1`, [userId])
}
// Unattributed FAILED_LOGIN rows from the wrong-password probe.
await sql(
  `delete from audit_log where user_id is null and event='FAILED_LOGIN'
    and occurred_at > now() - interval '10 minutes'`)
```

The last statement is the defect. Section `[5b]` signs in with an unknown
account to prove an unknown account cannot authenticate. That writes a
`FAILED_LOGIN` row with a **null** `user_id`, which the temporary-user delete
above cannot match — so a second delete was added to remove it.

That delete describes a **shape**, not an **identity**:

| | |
| --- | --- |
| `user_id is null` | true of every unattributed failed login, from anyone |
| `event='FAILED_LOGIN'` | true of every failed login |
| `occurred_at > now() - interval '10 minutes'` | true of every recent one |

Nothing in the predicate distinguishes a row this run created from a row anyone
else created. Every unattributed failed sign-in in the preceding ten minutes —
a real customer mistyping their password, a credential-stuffing probe, an
earlier verification run — matched it exactly and was deleted.

### Why it wasn't caught

The residue check compared **counts**:

```js
check(`${t} back to baseline (${baseline[t]})`, now === baseline[t])
```

`baseline.audit_log` was captured in section `[2]`, **before** `[5b]` ran. So the
baseline was 2, the run added 1 (total 3), and the shape-delete removed all 3.
The count then read 0 against a baseline of 2 and the check failed — which is
the only reason this was noticed at all.

Had the arithmetic happened to balance — one pre-existing row destroyed, one test
row left behind — the count would have matched and the loss would have been
invisible. **A count is not an identity.** That is the deeper bug, and it is the
one the fix targets.

### Sequence

```
[2]  baseline captured                      audit_log = 2   (2 pre-existing)
[5b] unknown-account probe writes a row     audit_log = 3
[7]  temp user's rows written and deleted   audit_log = 3
     teardown: shape-delete matches all 3   audit_log = 0
[8]  residue: 0 ≠ 2                         FAIL
```

---

## 2. The fix

Three changes, in `scripts/verify-bag-production.mjs`.

**Artifacts are identified at creation time.** `captureNewAuditRows(label, action)`
snapshots audit ids around any action that writes them, and records the
difference in `CREATED_AUDIT_IDS`. Anything already present is excluded by
construction, so a concurrent real event cannot be mistaken for a test artifact.
It wraps sign-up, sign-out, the wrong-password probe, and the unknown-account
probe.

**Teardown deletes only those ids, and is guarded.**

```js
const deletable = [...CREATED_AUDIT_IDS].filter((id) => !PRE_EXISTING_AUDIT_IDS.has(id))
const refused   = [...CREATED_AUDIT_IDS].filter((id) =>  PRE_EXISTING_AUDIT_IDS.has(id))
if (refused.length) console.log(`    REFUSED to delete ${refused.length} pre-existing audit row(s)`)
if (deletable.length) await sql(`delete from audit_log where id = any($1::uuid[])`, [deletable])
```

No time window, no event-type match, no `user_id is null`. The intersection
against `PRE_EXISTING_AUDIT_IDS` means even a bug in the capture logic cannot
reach protected history. Users, sessions, carts and cart_lines are still removed
by the temporary user's id — a UUID generated during the run, which nothing
pre-existing can reference.

**Preservation is asserted, not inferred.** Section `[2]` records the id of every
audit row that already existed; section `[8]` asserts every one still exists,
*before* it looks at any count:

```
ok    all 588 pre-existing audit rows survived
ok    every audit row created by this run was removed
```

A matching count no longer stands in for the property that actually matters.

**`--http-only` deletes nothing.** With no database connection it leaves its
`FAILED_LOGIN` row in place and says so. A failed sign-in attempt is genuine
security telemetry; the correct handling is to leave it, not to erase it.

---

## 3. The regression test

`scripts/verify-harness-cleanup.mjs`, development-only — it refuses to run
against the production fingerprint, because proving a cleanup routine is safe is
not something to prove on the history that matters.

It plants four sentinel rows, including one that is byte-for-byte the shape the
old predicate targeted (`user_id` NULL, `FAILED_LOGIN`, `occurred_at` now), runs
the real verifier as a child process, and asserts every sentinel survived.

**Against the fixed verifier — 9 passed, 0 failed:**

```
ok    survived: unattributed FAILED_LOGIN, right now (the destroyed shape)
ok    survived: unattributed FAILED_LOGIN, one minute old
ok    survived: unattributed LOGOUT
ok    survived: FAILED_LOGIN attributed to a pre-existing user
ok    all 4 sentinels present by marker
ok    verifier left audit_log at the count it found it
ok    the verifier itself asserted audit preservation
ok    the verifier no longer deletes by time window
ok    sentinels removed by id
```

**Against the pre-fix verifier (`VERIFIER_SCRIPT=` the version from `94ce7a7`) —
5 failed, reproducing the production symptom exactly:**

```
FAIL  survived: unattributed FAILED_LOGIN, right now (the destroyed shape)
FAIL  survived: unattributed FAILED_LOGIN, one minute old
FAIL  all 4 sentinels present by marker — found 2
FAIL  verifier left audit_log at the count it found it — 592 -> 590
FAIL  the verifier itself asserted audit preservation
```

`592 -> 590` — a loss of exactly two rows, the same delta seen in production. The
test has teeth: it fails on the old code and passes on the new.

Both runs were against **development**. Production was not touched.

---

## 4. The two lost rows

### What they most likely were

Not certain, and deliberately not reconstructed from memory. The evidence:

- I ran `--http-only` against production exactly **twice** (once after the
  v0.9.0 deployment, once after the follow-up deployment). Each run executes the
  `[5b]` unknown-account probe once, and each such probe writes exactly one
  `FAILED_LOGIN` row with a null `user_id`. Both runs reported `17 passed`,
  which includes that assertion.
- That accounts for exactly two rows of exactly the shape the faulty predicate
  matched.
- `audit_log` stood at exactly 2 when the full run captured its baseline.

So the balance of evidence is that both rows were **telemetry generated by my own
verification probes**, not customer or attacker activity. That lowers the
practical impact considerably — but it does not change the defect, which would
have deleted a real customer's failed-login history just as readily.

**This inference must not be treated as the answer.** The recovery branch below
shows the actual rows; that is the only thing that settles it.

### Can they be recovered?

**Yes, if the deletion falls inside the project's history-retention window.**
Neon retains a write-ahead history and can open a branch at a past timestamp.
That branch is a copy-on-write view of the whole cluster at that instant, so the
rows can be read back with every column intact — including `id`, `occurred_at`,
`ip_hash` and `user_agent_hash`. Because `id` is the primary key and is
preserved, re-inserting restores the rows identically rather than approximately.

Two things to confirm before relying on it:

1. **Retention.** Neon console → project → Settings. Free/Launch tiers retain
   24 hours by default; paid tiers can be configured up to 7 or 30 days. The
   deletion occurred on 2026-07-31 in the ~21:40–22:10 UTC window, so any
   retention setting of a day or more covers it — but the 24-hour case means
   this should not be left for a week.
2. **`audit_log` has no foreign key to `users`.** It is deliberately
   unconstrained (`lib/db/schema/audit.ts`: "the log has to outlive the row it
   describes"), so restoring rows cannot fail on a missing user, and the null
   `user_id` on these two rows makes it moot regardless.

### Minimal recovery plan — restores only those rows

**Nothing below runs until you approve it. No restore, no write, has been
performed.**

**R1 — Open a read-only branch at a point before the deletion.**

```
Neon console → cloud-market → Branches → New branch
  Source:  production (main)
  Include data up to:  a specific date and time
  Timestamp (UTC):  2026-07-31 21:38:00
  Name:  recover-audit-20260731
```

`21:38` is an estimate: after both rows were created (~21:33 and ~21:35 UTC) and
before the full verification run. It is cheap to get wrong — the branch is
read-only and disposable, so if the query below returns the wrong number, drop
it and pick a different timestamp. Later if it returns 0 rows (the deletion had
already happened); earlier if it returns fewer than 2 (a row had not been written
yet).

**R2 — Read the rows (read-only).**

```sql
SELECT id, event, user_id, occurred_at, ip_hash, user_agent_hash,
       entity_type, entity_id, summary
FROM audit_log
ORDER BY occurred_at;
```

Expect exactly 2 rows. **Inspect them before going further** — this is where the
inference in the previous section is confirmed or refuted. If they are anything
other than the two probe-generated `FAILED_LOGIN` rows, stop and reassess: it
would mean production had audit history that neither of us accounted for.

**R3 — Confirm they are genuinely absent from production.**

```sql
-- against production/main
SELECT count(*) FROM audit_log;                    -- expect 0
SELECT count(*) FROM audit_log WHERE id IN (<the two ids>);  -- expect 0
```

**R4 — Insert exactly those two rows into production.**

```sql
-- against production/main, values copied verbatim from R2
INSERT INTO audit_log
  (id, event, user_id, occurred_at, ip_hash, user_agent_hash,
   entity_type, entity_id, summary)
VALUES
  (<row 1 values>),
  (<row 2 values>)
ON CONFLICT (id) DO NOTHING;
```

`occurred_at` must be supplied explicitly — the column defaults to `now()`, and
letting it default would falsify the timestamp. `ON CONFLICT DO NOTHING` makes
the statement safe to run twice.

This is a two-row `INSERT`. It does not rewind production, does not restore a
snapshot over the live database, and cannot overwrite anything written since —
which matters, because the v0.9.0 deployment is live and serving.

**R5 — Verify and clean up.**

```sql
SELECT count(*) FROM audit_log;   -- expect 2
```

Then delete the `recover-audit-20260731` branch in the Neon console. Neon
branches cost storage while they exist.

### The alternative

If R2 confirms both rows were my own probe artifacts, **doing nothing is a
defensible choice**: the recovered rows would record that an automated check
attempted a login with a nonexistent account, which has no security or
compliance value. Restoring them is still the more conservative option, and the
plan above is cheap. That call is yours — I have not made it.

---

## 5. What changes beyond this fix

The failure mode was not "a wrong `WHERE` clause". It was **a cleanup routine that
identified its own artifacts by description instead of by identity**, in a table
whose entire purpose is to be a permanent record. Two rules now apply to any
harness that writes to production:

1. Capture the identity of everything you create, at the moment you create it.
2. Never delete to make a count match. If the count disagrees, that is the
   finding — report it.

The audit log is the one table where "close enough" is never close enough.
