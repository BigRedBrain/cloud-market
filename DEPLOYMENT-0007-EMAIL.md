# Production rollout — migration 0007 and Resend configuration

Status: **not started.** Nothing has been merged, pushed, migrated, configured or
sent. This is the plan to be reviewed before any of that happens.

Blocked on one prerequisite: the development credential rotation (§0).

---

## 0. Prerequisite — development credential rotation

Not a production step, and not optional before merge. The development Neon
password was exposed repeatedly during debugging, including once by the
assistant printing a connection string into its own console output.

Rotate the **development** branch role password in the Neon console, update
`.env.local` with the new pooled and direct strings, then:

```powershell
$env:OLD_DATABASE_URL      = "<the PRE-rotation development pooled string>"
$env:PRODUCTION_POOLED_URL = "<production pooled string>"
node scripts/verify-dev-credential.mjs
```

Both extra variables are optional; supplying them upgrades two checks from
skipped to proven. The script prints no credential — every value is reduced to a
12-character SHA-256 fingerprint first.

Expected: `RESULT: 11 passed, 0 failed, 0 skipped`, including

```
ok  the rotated-away password is NOT in .env.local
ok  the old credential can no longer authenticate
ok  the development password is REJECTED by production
```

Afterwards clear those two variables from the shell so a later command cannot
pick them up by accident.

**Gate:** 0 failed. Then rerun the full suite (§1) and merge.

---

## 1. Pre-merge regression

Against the rotated development database:

```
npm run test:recovery   (dev server, EMAIL_PROVIDER=capture,
                         RECOVERY_FAULT_INJECTION=after_consume)
npm run test:email
npm run test:e2e        (production build)
npm run test:bag        (production build)
npm run test:auth
npm run lint / typecheck / build
```

Expected: 116, 12, 94, 63, 28, clean. The recovery suite must be run with the
fault-injection seam enabled or it skips the four atomicity assertions — and it
says so rather than passing quietly.

**Gate:** all green. Merge `feat/account-recovery` into `main`. **Do not push
yet** — see §3.

---

## 2. What is being deployed

| Migration | Contents | Shape |
| --- | --- | --- |
| `0007_cloudy_kulan_gath.sql` | 8 new `audit_event` values; `verification_tokens.superseded_at`; index on `(user_id, purpose, created_at)` | Additive. No table created, none rewritten, no backfill. |

Application code: `lib/email/*`, `lib/auth/tokens.ts`,
`lib/auth/email-actions.ts`, four new routes, the confirmation and reset forms,
`proxy.ts` token-URL headers.

### The one-way part

`ALTER TYPE … ADD VALUE` **cannot be reversed.** Postgres has no
`DROP VALUE`, and removing one means recreating the type and rewriting every
dependent column. This migration adds eight labels:

```
EMAIL_VERIFICATION_REQUESTED   PASSWORD_RESET_REQUESTED   SESSIONS_REVOKED
EMAIL_VERIFIED                 PASSWORD_RESET_COMPLETED   EMAIL_SEND_FAILED
EMAIL_VERIFICATION_FAILED      PASSWORD_RESET_FAILED
```

They are inert until code writes them. The correct response to a problem after
this lands is to roll back the *code* and leave the labels unused — not to
attempt a reversal far riskier than the thing it undoes. Same posture as 0006,
and worth stating plainly before it happens rather than after.

---

## 3. Ordering — migration before code, and why here

**Required.** Unlike Phase 3, the failure is immediate and total rather than
partial.

Every recovery action writes an audit row as its first or last step:
`EMAIL_VERIFICATION_REQUESTED` on resend, `PASSWORD_RESET_REQUESTED` on every
reset request, `EMAIL_VERIFIED`, `PASSWORD_RESET_COMPLETED`, `SESSIONS_REVOKED`.
If the code ships before the enum values exist, every one of those inserts fails
with `invalid input value for enum audit_event`, and:

- the reset request path throws **inside `after()`**, after the response has
  already been sent — so the customer sees "check your email" and nothing is
  ever sent, with the failure visible only in server logs;
- `confirmEmailAction` and `completePasswordResetAction` fail *after* their
  transaction commits, since the audit write is deliberately outside it — the
  mutation lands, the audit row does not;
- `verification_tokens.superseded_at` would not exist either, so `issueToken`
  fails outright and no token is ever created.

There is no symmetric risk in migrating first: the new column is nullable and
the new enum labels are unreferenced, so the currently-deployed code cannot
notice them.

**Deploying code before configuring Resend is fine** — that ordering is covered
in §5 and is deliberately safe.

---

## 4. Migration sequence

### 4a — Pre-flight

```powershell
$env:DATABASE_URL = "<production POOLED string>"
node scripts/verify-bag-production.mjs https://cloud-market-ten.vercel.app --allow-production --preflight
```

Expect `target confirmed` and 7 migrations applied (0000–0006).

### 4b — Snapshot

Neon console → Branches → New branch from production/main, named
`pre-0007-<date>`. Copy-on-write and effectively instant. The rollback substrate
for §8.

### 4c — Verify the write target

```powershell
$env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"
$env:PRODUCTION_POOLED_URL = "<production POOLED string>"
node scripts/verify-migration-target.mjs https://cloud-market-ten.vercel.app
```

> Set `DATABASE_URL_UNPOOLED`, **not** `DATABASE_URL`. `drizzle.config.ts` loads
> `.env.local` and resolves `DATABASE_URL_UNPOOLED ?? DATABASE_URL`; setting only
> the latter leaves the development value from the file in place, and it wins.

The gate expects 5 journal entries and no cart tables, which was true for the
Phase 3 rollout and is not now. **Expect it to report NO-GO on those two
counts.** Read the reasons; the ones that matter are that the resolved target is
the same Neon branch as the pooled string and that the pooled string matches
`/api/health`. Both must hold.

*(Improving that script to take an expected-journal-length argument is a small
follow-up, noted rather than done, because changing a safety gate immediately
before using it is how safety gates stop being trustworthy.)*

**Gate:** target confirmed as production/main; journal at 7.

### 4d — Migrate

```powershell
npx drizzle-kit migrate
```

### 4e — Confirm

Re-run 4a. Expect 8 migrations. Then:

```sql
-- read-only
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'verification_tokens' AND column_name = 'superseded_at';
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'audit_event' AND enumlabel LIKE 'EMAIL%' OR enumlabel LIKE 'PASSWORD_RESET%';
```

**Gate:** column present, 8 labels present, `/api/health` still ok, `/`, `/shop`,
`/bag` still 200.

**Safe resting point.** Schema is ahead of code and nothing reads it. The deploy
can wait here indefinitely.

---

## 5. Provider configuration

### 5a — Domain and DNS

In Resend: add the sending domain and publish the records it issues.

| Record | Purpose |
| --- | --- |
| **SPF** (`TXT`, `v=spf1 include:…`) | Authorises Resend's servers to send as the domain. Without it, receivers see an unauthorised sender. |
| **DKIM** (`TXT`, selector `resend._domainkey`) | Signs each message so tampering is detectable and the domain's reputation attaches to it. |
| **DMARC** (`TXT`, `_dmarc`) | Not required by Resend, recommended. Start at `p=none` to observe, tighten later. Publishing `p=reject` before SPF/DKIM are confirmed aligned will bounce real mail. |

A dedicated subdomain (`mail.` or `notifications.`) is worth using so
transactional reputation is isolated from anything the retailer sends later.

**State plainly to the provider that this is transactional-only mail**: account
verification and password reset, no marketing, no product content. Several ESPs
restrict cannabis-adjacent senders, and enforcement is generally aimed at
marketing. Phase 2.5's campaign engine must not be pointed at this transport.

**Gate:** Resend reports the domain verified, SPF and DKIM both green.

### 5b — Verify fail-closed BEFORE configuring

Do this while production still has no email variables. `EMAIL_PROVIDER` is unset,
so it defaults to `console` — and production refuses console:

- Sign in to production, visit `/account/verify-email`, request a confirmation.
- Expect: the action returns without error, and an `EMAIL_SEND_FAILED` audit row
  appears. No email is sent, no link is printed anywhere, and no reset link ends
  up in a log.

This is the only opportunity to observe the fail-closed path against real
production, and it is cheap. Covered by `npm run test:email` at unit level
(12/12), but seeing it once in production is worth the two minutes.

**Gate:** `EMAIL_SEND_FAILED` present; nothing delivered; no token in any log.

### 5c — Configure

Vercel → Settings → Environment Variables, **Production only**, each marked
**Sensitive**:

| Variable | Value |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | the API key |
| `EMAIL_FROM` | `Cloud Market <no-reply@[domain]>` |
| `EMAIL_REPLY_TO` | a real monitored address |

**Preview and Development must not receive these.** Preview has no
`DATABASE_URL` either and is fail-closed by construction; adding an email key
there would let a preview deployment send real mail from the production domain.

### 5d — Confirm `NEXT_PUBLIC_APP_URL`

```
https://cloud-market-ten.vercel.app     (or the custom domain, once live)
```

Every link in every email is built from this and never from a request header —
a `Host`-derived reset link would deliver a live credential to whatever domain
an attacker put in the header. Check it is the canonical origin, has no trailing
slash issues, and matches where customers actually land. **If a custom domain is
planned, set it before sending anything**, or the first batch of reset links
will point at the wrong origin.

**Gate:** value confirmed; a redeploy has picked it up (it is inlined at build
time, so changing it requires a rebuild).

---

## 6. Deploy the code

```powershell
git push origin main
git push origin v0.10.0    # if tagging this phase
```

Vercel auto-deploys `main`. The build runs `next build` only — no migration step
— which is why §4 and §6 are separate and ordered.

**Gate:** deployment Ready; `/api/health` ok; `/`, `/shop`, `/bag`, `/sign-in`
all 200; `/forgot-password` renders.

---

## 7. Post-deployment verification

Everything below uses Resend's reserved test addresses or a temporary account
that is removed by id. **No fake product is created** (same reasoning as Phase 3:
ISR means a fake cannabis product could be visible to real customers for up to
60s after deletion).

### 7a — Transport smoke tests

| Address | Expected |
| --- | --- |
| `delivered@resend.dev` | Accepted and delivered. Confirms API key, domain and DKIM. |
| `bounced@resend.dev` | Hard bounce. Confirms failures surface rather than silently disappearing. Bounce *handling* is out of scope this phase; the point is to see the failure. |

Trigger via a temporary account whose email is the test address.

**Gate:** delivered case succeeds; bounced case produces `EMAIL_SEND_FAILED`, and
the token issued for it is **gone** (delivery failure discards it, so the
customer's throttle budget is not spent on our failure).

### 7b — Verification, end to end

1. Create a temporary production account (real inbox you control).
2. `/account/verify-email` → request. Email arrives.
3. **Open the link 3 times without submitting.** Confirm `email_verified_at` is
   still null and `consumed_at` is still null — the scanner property, checked
   where it actually matters.
4. Submit the Confirm button. `email_verified_at` set, `EMAIL_VERIFIED` audited,
   redirect lands on `/sign-in?verified=1` with **no token in the URL**.
5. Re-open the link: reports "already confirmed", changes nothing.
6. Check response headers on the token URL: `no-store`, `no-referrer`,
   `X-Robots-Tag: noindex`.

### 7c — Password reset, end to end

1. `/forgot-password` with the temporary account's address.
2. Email arrives; **open the link twice without submitting**; confirm the token
   is unconsumed, sessions intact, old password still working.
3. Sign in on two devices so there are two live sessions.
4. Submit a new password. Confirm: redirect to `/sign-in?reset=done`; **no
   session was created**; **both prior sessions are gone**; old password
   rejected; new password works; `PASSWORD_RESET_COMPLETED` and
   `SESSIONS_REVOKED` audited.
5. Replay the link: rejected, password unchanged.

### 7d — No account enumeration

Submit `/forgot-password` for a real address and a nonexistent one. Compare:

- HTTP status
- `Location` header
- rendered body of `/forgot-password/sent`
- response time (should be comparable — the differing work happens in `after()`)

All four must be indistinguishable. Then confirm no `verification_tokens` row
and no `users` row exists for the nonexistent address, and that its
`PASSWORD_RESET_REQUESTED` audit row carries `user_id` NULL with **no summary and
no entity id**.

### 7e — Secret hygiene

```sql
-- read-only, over the whole audit log
SELECT count(*) FROM audit_log WHERE summary LIKE '%http%';   -- expect 0
SELECT count(*) FROM audit_log WHERE summary LIKE '%@%';      -- expect 0
```

Plus: no raw token in Vercel logs, and `verification_tokens.token_hash` is
64-hex for every row.

### 7f — Cleanup and baseline

Capture counts for `users`, `sessions`, `verification_tokens`, `audit_log` before
starting. Afterwards remove the temporary account **by id** — tokens, sessions,
audit rows, then the user — and re-assert every count.

**The Phase 3 rule applies:** delete by captured identity only. No time windows,
no `WHERE event = …`. Pre-existing audit rows are snapshotted and must survive;
a shape-based delete is what destroyed two production audit rows in Phase 3.

**Gate:** every count back to baseline; every pre-existing audit id still
present.

---

## 8. Rollback and failure behaviour

| Failure | Blast radius | Response |
| --- | --- | --- |
| Migration fails part-way | None. DDL is transactional; the schema is untouched. | Read the error, do not deploy code, re-run. |
| Deploy fails to build | None. Vercel keeps serving the previous deployment. | Fix and re-push. Schema ahead of code is the safe direction. |
| Code deployed, Resend not yet configured | Recovery emails do not send; `EMAIL_SEND_FAILED` is audited; tokens are discarded so throttles are not consumed. Sign-in, browsing and the bag are unaffected. | Complete §5. This state is safe and is the *expected* state between §6 and §5c if they are done in that order. |
| Domain not verified / DKIM wrong | Mail is rejected or lands in spam. Same audited failure path. | Fix DNS. Do not work around it by sending from a Resend-owned domain. |
| Functional bug in the recovery flow | Recovery is affected; the rest of the storefront is not. | `vercel rollback` to the previous deployment. **Leave migration 0007 in place** — additive schema is inert to code that does not know about it. |
| Enum values need reverting | Effectively impossible. | Do not attempt. Roll back the code and leave the labels unused (§2). |
| Reset link delivered to the wrong origin | Serious — tokens sent to a domain we do not control. | Only possible if `NEXT_PUBLIC_APP_URL` is wrong, which §5d exists to prevent. If it happens: correct the value, redeploy, and invalidate outstanding reset tokens with `UPDATE verification_tokens SET superseded_at = now() WHERE purpose='password_reset' AND consumed_at IS NULL`. |

**Rollback is asymmetric by design.** Code reverts in seconds; schema does not
need to. Because 0007 is additive, schema-ahead-of-code is always safe and
code-ahead-of-schema is the only dangerous state — which §3 exists to prevent.

---

## 9. After rollout

- Decide on IP-scoped rate limiting. Per-account throttles already cap any one
  address at 5 sends/day regardless of source; what is unbounded is aggregate
  volume across many addresses, which is a provider-quota concern. A Postgres
  bucket table is preferred over adding a vendor.
- Consider bounce and complaint webhooks. Out of scope this phase, but once real
  mail flows, repeated hard bounces to a stored address are worth acting on.
- `RECOVERY_FAULT_INJECTION` must not be set in production. It is inert there
  regardless — the seam checks `NODE_ENV` first, then requires a per-request
  header — but it should not be present.

**Out of scope, unchanged:** checkout, orders, payments, delivery, taxes,
discounts, inventory reservation, 2FA, magic links, OAuth, email-address change,
marketing email.
