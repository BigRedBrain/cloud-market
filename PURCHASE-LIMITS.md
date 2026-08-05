# Purchase Limit Administration (Phase 4.1)

Branch `feat/checkout-orders`. Migrations 0009 and 0010, development only —
production remains on 0007.

An admin screen at `/admin/purchase-limits` for publishing the daily caps
enforced at checkout. Rules are immutable and versioned: publishing inserts a
new row and closes the previous one. Nothing here can be edited or deleted.

---

## 1. Why the database enforces this, not the application

A `purchase_limit_rules` row is the legal basis on which cannabis was sold to a
named person on a named day. `order_lines.purchase_limit_rule_id` points at the
exact row an order was checked against.

If a row could be edited, the stated basis of orders already placed would change
retroactively. If a row could be deleted, an order would cite nothing. Neither
may be possible — including to a future maintainer with a `psql` prompt and a
good reason.

So the guarantee lives in three places, and the application is only one of them:

| Guard | What it stops |
| --- | --- |
| `purchase_limit_rules_immutable` trigger | Any UPDATE touching a value column |
| `purchase_limit_rules_no_delete` trigger | Every DELETE, unconditionally |
| `order_lines.purchase_limit_rule_id` FK `restrict` | Deleting a rule an order cites |
| `purchase_limit_rules_window_ordered` CHECK | A window ending before it starts |
| `supersedes` / `superseded_by` self-FKs `restrict` | Deleting a rule another rule cites |

The one permitted mutation is closing the window (`effective_until`) and
recording the successor (`superseded_by_rule_id`) — each once, from null.

### The one relaxation, and why it isn't one

Migration 0010 allows `effective_until` to move **while it is still in the
future**. 0009 froze it on write, and the governance suite found the case that
made that untenable: once a change is scheduled, the outgoing rule is already
closed at the future start instant, so an urgent correction had nowhere to go.
There was no way to fix a cap today if any change was pending for Tuesday.

The principle that actually matters is narrower than "nothing changes": *nothing
which has already governed a sale may change.* A boundary in the future has
governed nothing — no order was checked against it, no receipt cites it. The
instant it passes, it is permanent. A closed rule can never be reopened, and no
boundary may be moved into the past.

---

## 2. Permission

`compliance_admin` is a **named grant**, not a role.

```
user_permissions (user_id, permission, granted_at, granted_by,
                  revoked_at, revoked_by, reason)
```

**Holding `admin` does not confer it.** An administrator who has not been
explicitly granted it gets a 403 from these screens — verified over HTTP, not
just asserted. The set of people who may change a legal cap is a list someone
signed, and its whole value is that it is shorter than the list of
administrators.

Revocation is a timestamp, never a delete: "who could publish a limit change in
March" is a question an auditor asks, and a deleted row cannot answer it. A
partial unique index permits one live grant per user per permission, so the same
permission can be granted, revoked and granted again without losing either
episode.

### Granting is not a button

```bash
npm run perm -- --email=someone@example.com --list
npm run perm -- --email=… --grant=compliance_admin --reason="…" --confirm
npm run perm -- --email=… --revoke=compliance_admin --confirm
```

If `compliance_admin` could be granted from the same application it governs,
compromising any administrator account would be enough to grant it to yourself
and then use it — the separation would be decorative. Granting requires direct
database access, a different credential held by fewer people. That is
deliberately inconvenient.

---

## 3. What publishing requires

Six gates, each catching something the others do not:

1. **Permission** — `requirePermission('compliance_admin')`, before anything
   else can be learned from the action.
2. **Validation** — the numbers must be coherent. Runs before the password
   prompt so a typo does not cost a re-authentication.
3. **Re-authentication** — the password again, in this request.
4. **Confirmation** — the class name typed by hand, plus an explicit
   acknowledgement that the version is permanent.
5. **Publish** — insert and supersede, in one transaction.
6. **Audit** — every outcome, including the refusals.

The permission check is first on purpose: an unauthorised caller must not be
able to use the action as an oracle for whether a password is correct.

### Re-authentication is not a session flag

`lib/auth/reauth.ts` returns a **timestamp to the caller**, valid only within the
action that produced it. There is deliberately no "re-authenticated for the next
15 minutes" window — a grace window is a bearer credential in disguise, and the
point of the step-up is that it happens in the same request as the write.

Throttled at 5 failures per 15 minutes, counted from the audit log, and every
attempt is recorded. A run of failures against a compliance permission is
exactly what an investigation looks for, and it is worthless if only successes
are written. The instant is stored on the rule as `reauthenticated_at`: "a
session made this change" and "the holder re-proved who they were seconds
beforehand" are different claims, and only the second is worth anything when the
change is contested months later.

### Reasons

Minimum 20 characters. `changeReason` is the audit record — "updated" explains
nothing to whoever reads it during an inspection two years from now.

---

## 4. Versioning and time

Windows are half-open, `[effective_from, effective_until)`, so "which rule
applied at time T" has exactly one answer for every T. Versions are numbered per
class from the maximum that class has ever held.

Publishing is three statements, not two, because the partial unique index
permits one row per class with a null `effective_until`:

1. close the outgoing rule at the new rule's start instant
2. insert the new rule, pointing back at the old one
3. write the forward pointer on the old row

All inside one transaction, with the outgoing row locked `FOR UPDATE` first.

### Immediate means database time

`effectiveFrom: null` hands the timestamp to Postgres. Passing `new Date()`
instead is wrong, and the governance suite proved it: this machine's clock runs
ahead of the database's, so a rule stamped "now" from Node was **not yet in
force** and checkout silently kept the old cap. Same rule as every expiry
comparison in Phase 4 — the clock is the database's.

### Scheduling, and cancelling a schedule

A future `effective_from` schedules a change. The current rule is closed at that
future instant, so the invariant holds continuously while the change is pending,
and checkout keeps using the old cap until the date arrives.

Publishing again before that date closes the pending rule at its own start
instant — an empty window, so it never governs anything. That is how a scheduled
change is cancelled **without deleting the evidence that it was scheduled**. The
history shows it as `Cancelled before taking effect`.

An urgent immediate change while one is pending reaches past the pending rule
and re-closes the rule actually in force, found **by query rather than by
following `supersedes_rule_id`** — one link back from a pending rule is not
necessarily the rule in force, and closing a cancelled rule at the present
instant would put its end before its start.

### Contention

Two officers publishing at once serialise on the row lock. The loser's
`FOR UPDATE` re-evaluates its predicate against the committed row, which no
longer has a null `effective_until`, so it drops out of the result. Deriving the
version from that would restart numbering at 1 and collide with the existing
history — caught by the unique index on `(cannabis_class, version)`, but as a
raw constraint error. The loser is now told to reload instead.

---

## 5. What an order keeps

| When | What happens |
| --- | --- |
| Draft created | Line records the rule in force then |
| Order placed | Line is **re-stamped** with the rule in force at placement |
| Rule changes afterwards | Line is untouched, forever |

A draft may be created under one version and placed under its successor — the
window is fifteen minutes, but a scheduled change can land inside it. The
evaluation at placement uses the rule in force *now*, so the line records that
one. After placement the rule id is fixed, which is what makes "existing orders
keep their original rule" true rather than aspirational.

---

## 6. Verification

```
npm run test:governance     77 passed, 0 failed   (database + domain)
npm run test:limits:http    44 passed, 0 failed   (HTTP surface)
```

### Governance (`test:governance`)

Runs against the real database, because every property under test is a property
*of* the database. Covers: every value column rejecting UPDATE; DELETE rejected;
a passed boundary frozen; a closed rule not reopenable; the check constraint;
publish/supersede with the chain linked both ways; identical values refused; a
past start date refused; scheduling; cancelling a pending change; an urgent
change overtaking a pending one; **no two non-empty windows overlapping anywhere
on the timeline**; simultaneous publishes; a placed order keeping its rule
through a change; a cited rule refusing deletion; step-up success, failure,
no-password and throttling; grant, revoke and re-grant.

**Teardown is the hard part.** The table cannot be deleted from — that is the
point of it. So teardown disables the two guards, removes only ids captured
during the run, restores the pre-existing rule verbatim, re-enables both guards,
and then *asserts all of it*, including that DELETE is refused again afterwards.
A suite that leaves the guards off would be worse than no suite.

### HTTP (`test:limits:http`)

A correct trigger behind a page that renders for anyone is still a hole. This
drives real requests with real cookie jars, submitting hidden `$ACTION` fields
as a browser without JavaScript would.

The assertion that matters most: **the Server Action refuses an ungranted
admin** who copies the action id out of a page and posts it directly. A Server
Action is a public POST endpoint; the page being unreachable proves nothing.

Also covers each validation refusal end to end, and one genuine publish —
asserting the new version, the closed predecessor, both audit events, and that
the page renders both.

### Regression

```
test:math      29    test:concurrency 28    test:auth     28
test:e2e       94    test:bag         63    test:email    12
test:browser   26    test:browser:guard 25  test:recovery 151
lint 0 errors · typecheck clean · build clean
```

`test:recovery` reports **151**; the Phase 4 note recorded 155. The script is
unmodified (`git diff` clean) and all ten sections executed — 75, 8, 2, 15, 23,
3, 4, 13, 4, 4 — with nothing skipped and nothing failing. The earlier figure
appears to have been recorded from a run with more iterations in section [1]'s
scanner loop; I did not chase it further.

---

## 7. A defect this work fixed elsewhere

`recordAuditEvent` read request headers inside the same `try` as the INSERT.
Outside a request scope — a scheduled sweep, a background job, a script —
`headers()` throws, so the throw skipped the write and **the event was silently
lost**. Losing the IP is a degradation; losing the fact that a compliance action
happened is a hole in the record. The header read now fails soft and the row is
written either way.

---

## 8. Known limitations

1. **No production verification yet.** Production has no catalog and no rules.
   See §9.
2. **No UI for granting the permission**, by design (§2). An operator with
   database access is required.
3. **Timezone.** `datetime-local` carries no zone, so a scheduled instant is
   server time (UTC on Vercel). The form says so. A store-local timezone needs a
   store timezone field, which the schema does not carry.
4. **No approval workflow.** One grant holder can publish alone. Two-person
   sign-off would be a second permission and a pending-approval state.
5. **No diff preview.** The form shows the current values beside the inputs but
   does not render a before/after summary before submission.
6. **Purchase limit values still need legal confirmation** — unchanged from
   Phase 4. This work governs *how* they change, not what they should be.

---

## 9. Production verification checklist

Extends the Phase 4 checklist in [ORDERS.md](ORDERS.md) §12. Requires migrations
0008, 0009 and 0010 applied through the gated sequence.

### Schema

- [ ] Journal at 11 entries
- [ ] `user_permissions` exists with its partial unique index
- [ ] `purchase_limit_rules` has `version`, `change_reason`, `published_by`,
      `published_at`, `reauthenticated_at`, `supersedes_rule_id`,
      `superseded_by_rule_id`
- [ ] Both guard triggers exist and are enabled (`tgenabled = 'O'`)
- [ ] `order_lines.purchase_limit_rule_id` exists with `ON DELETE RESTRICT`
- [ ] Existing rules were backfilled with the pre-versioning `change_reason`

### Permission

- [ ] `npm run perm -- --email=… --list` shows no unexpected grants
- [ ] Grant to the named compliance officer with a reason citing the authority
- [ ] `PERMISSION_GRANTED` audited
- [ ] An admin **without** the grant gets 403 on `/admin/purchase-limits`
- [ ] The nav tab is absent for them
- [ ] The grant holder can open the page

### Publishing

- [ ] Publish a rule with the legally confirmed values
- [ ] Wrong password → refused, `COMPLIANCE_REAUTH_FAILED` audited, nothing published
- [ ] Mistyped confirmation → refused
- [ ] Missing acknowledgement → refused
- [ ] Reason under 20 characters → refused
- [ ] Correct publish → new version in force, previous closed and unchanged,
      chain linked both ways
- [ ] `PURCHASE_LIMIT_RULE_PUBLISHED` and `_SUPERSEDED` audited
- [ ] `published_by` and `reauthenticated_at` populated

### Immutability, against production itself

- [ ] `UPDATE purchase_limit_rules SET daily_equivalent_grams_cap = …` → rejected
- [ ] `DELETE FROM purchase_limit_rules WHERE id = …` → rejected
- [ ] Neither statement changed a row

### Orders

- [ ] A placed order's line carries a `purchase_limit_rule_id`
- [ ] After publishing a new version, that order still cites the original
- [ ] Deleting the cited rule is rejected

### Cleanup

- [ ] No test rule was published to production — rules cannot be removed, so
      **only publish values you intend to keep**
- [ ] Any test account removed by captured id
- [ ] Pre-existing audit rows all survive
