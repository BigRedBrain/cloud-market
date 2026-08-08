# Phase 5 — production rollout runbook

**Private storefront · invite-only registration · two-administrator model ·
crypto payment architecture**

Nothing in this document has been executed against production. Migration 0017
has not been applied anywhere. `CHECKOUT_ENABLED` and `CRYPTO_PAYMENTS_ENABLED`
both remain `false`.

---

## 0. The one-paragraph summary

This release makes the whole site require a login, makes registration require an
invite code, and reduces administration to two named people — you, pinned to an
environment variable, plus one optional backup. It adds one migration (0017),
which only CREATES new tables, one trigger and one index; it alters no existing
column and rewrites no existing row. The largest risk is not the migration. **It
is locking yourself out of `/admin` by getting `CLOUDMARKET_OWNER_USER_ID`
wrong**, which §2 exists to prevent.

---

## 0.1 The order, in one place

Each step is safe to stop at. **The ordering constraint that matters is that
every environment variable is set BEFORE the code that reads it is deployed, and
the migration lands BEFORE the code that queries the new tables.**

| # | Step | Why here and not later |
|---|---|---|
| 1 | Read the owner's `users.id` from production (§2.1) | Everything downstream depends on the value being right; reading it costs nothing and is reversible. |
| 2 | Fix `role`/`status` if needed, demote any third admin (§2.1–2.2) | Under the OLD code this changes nothing that matters; under the new code a wrong `role` locks the owner out. |
| 3 | Set **all four** production variables (§2.3, §4): `CLOUDMARKET_OWNER_USER_ID`, `INVITE_CODE_PEPPER`, `CHECKOUT_ENABLED=false`, `CRYPTO_PAYMENTS_ENABLED=false`. Confirm `BLOB_READ_WRITE_TOKEN` is present and points at a private-capable store | **The old code ignores every one of them**, so setting them early is inert. Setting them AFTER the deploy means a window in which the new code is live and every administrator is denied. |
| 4 | Verify the pre-migration state: 16 journal rows, empty catalog | The gate in step 5 asserts it, but knowing the expected number first is what makes a mismatch meaningful. |
| 5 | Gate: `node scripts/verify-migration-target.mjs --expect-migrations=16` → **GO** (§3.3–3.4) | Proves which database is about to be written to. A NO-GO is a stop. |
| 6 | `npm run db:migrate` — applies **0016 then 0017**, in that order, in the same window | 0017 assumes 0016's media columns. Never 0017 alone. |
| 7 | Confirm 18 journal rows, `admin_backup` present, trigger present | Cheap, and it is the last point before the code changes. |
| 8 | **Deploy the code** | New code queries `invite_codes` and `admin_backup` on the sign-up and admin paths. Deploying before step 6 gives 500s there. Migrating and deploying later is safe — the new tables are simply unused. |
| 9 | `/api/health` public (status + timestamp only) and `/api/health/internal` 401 (§6.2) | Confirms the right build is live before anything else is judged. |
| 10 | `/api/health/internal` with `Authorization: Bearer $CRON_SECRET`: `ownerIdentityConfigured`, `inviteCodesConfigured`, `mediaStorageConfigured` all **true**; both flags **false** | Answers "is the environment right" without a single credential leaving the server. |
| 11 | Login wall (§6.1) | The release's headline claim. Any 200 for an anonymous protected path is a roll-back. |
| 12 | **Admin access as the owner** (§6.3) | Do this before the invite round trip: if the owner is locked out, §8 is the next step and nothing else matters. |
| 13 | Invite round trip, including reuse refused (§6.4) | Needs step 3's pepper and step 6's tables. |
| 14 | An existing customer signs in without an invite (§6.5) | Proves enforcement applies to NEW registrations only. |
| 15 | Media privacy (§6.6) | Needs a real upload, so it comes after admin access works. |
| 16 | Privileges and purchase-limit rules unchanged (§6.7) | A check that nothing changed by accident. |

**The lockout-avoidance rule, stated once:** steps 1–3 happen entirely under the
OLD code, where none of them has any effect on who can administer the site. Step
8 is the only irreversible-feeling moment, and by then the owner identity has
already been verified twice. Rolling back reverses this order — **code first,
then variables** (§7), because removing `CLOUDMARKET_OWNER_USER_ID` under the
new code denies every administrator, while under the old code it is ignored.

---

## 1. Preconditions

| Check | Expected | How |
|---|---|---|
| Production schema version | 0015, **16 journal rows** | `select count(*) from drizzle.__drizzle_migrations;` |
| Migration 0016 status | **not yet in production** | It is the Phase 4.5 media migration. If it has not shipped, 0017 goes on top of 0016 — see §3.1 |
| `CHECKOUT_ENABLED` | `false` | Vercel → Settings → Environment Variables |
| `cloudmarket_app` privileges | unchanged | `npm run verify:privileges` |
| Local gate | green | `npm run typecheck && npm run lint && npm test && npm run build` |

> **On 0016.** The working tree contains `0016_yummy_tattoo.sql` (media columns)
> which the journal already lists but production has not applied. 0017 assumes
> 0016 is present. Apply them in order, in the same window, or split them into
> two releases — but never 0017 alone.

---

## 2. Establish the owner identity — DO THIS FIRST

**This is the step that can lock you out. Do it before anything else, and verify
it twice.**

### 2.1 Find the owner's user id

Against **production**, read-only:

```sql
select id, email, role, status, email_verified_at, deleted_at
from users
where email = lower('YOUR-OWNER-EMAIL@example.com');
```

Record the `id`. It must satisfy **all** of:

- `role = 'admin'`
- `status = 'active'`
- `deleted_at is null`

`requireAdminIdentity()` requires every one of these **in addition to** the id
matching the environment variable. If `role` is not `admin`, fix it now, before
the release:

```sql
update users set role = 'admin', updated_at = now() where id = '<owner-uuid>';
```

### 2.2 Confirm there are not already three admins

Migration 0017 installs a trigger capping `role = 'admin'` at two. It fires on
INSERT and UPDATE only, so pre-existing rows are not rejected — but you should
know:

```sql
select id, email, role from users where role = 'admin' and deleted_at is null;
```

If this returns more than two, demote the extras **before** applying 0017.
Under the new model they have no admin access anyway (their id matches neither
the owner variable nor the backup slot), so demotion costs them nothing.

### 2.3 Set the variable

Vercel → Settings → Environment Variables → **Production** only:

```
CLOUDMARKET_OWNER_USER_ID = <the uuid from 2.1>
```

Mark it **Sensitive**. Do **not** set it on Preview (preview branches have their
own databases and different user ids). Never prefix it `NEXT_PUBLIC_`.

### 2.4 Verify before deploying

Deploy to a **preview** with the production owner id temporarily set, or after
deploying to production check:

```
GET https://<prod>/api/health/internal
Authorization: Bearer $CRON_SECRET
```

The response must contain:

```json
"configuration": { "ownerIdentityConfigured": true, ... }
```

`false` means the value is missing or not a well-formed UUID, and **every
administrator will be denied** until it is fixed.

---

## 3. Apply migration 0017

### 3.1 What it does

| Object | Kind | Notes |
|---|---|---|
| 3 enums (`payment_provider`, `payment_intent_method`, `payment_intent_status`) | CREATE | new |
| 16 `audit_event` values | `ALTER TYPE … ADD VALUE` | additive only |
| `admin_backup` | CREATE TABLE | + 2 partial unique indexes, 1 CHECK |
| `invite_codes`, `invite_code_redemptions` | CREATE TABLE | + 2 CHECKs |
| `payment_intents`, `payment_events` | CREATE TABLE | + 2 CHECKs, partial unique indexes |
| `cloudmarket_enforce_max_two_admins()` + `users_max_two_admins` | CREATE FUNCTION / TRIGGER | hand-written; see below |
| `audit_log_rate_limit_idx` | CREATE INDEX | partial, on `ip_hash IS NOT NULL` |

**No `ALTER COLUMN`. No `DROP`. No `UPDATE`. No backfill.** Existing users,
orders, purchase-limit rules, media and permissions are untouched.

**Locking:** `CREATE TABLE` takes no lock on existing tables. The two statements
that touch a live table are:

- `CREATE TRIGGER users_max_two_admins` — takes a brief `SHARE ROW EXCLUSIVE` on
  `users`. Milliseconds on any realistic user count, but it does block writes
  for that instant.
- `CREATE INDEX … ON audit_log` — takes a `SHARE` lock, **blocking writes to
  `audit_log` for the duration of the build**. On a large audit table this is
  the longest statement in the migration. If `audit_log` is big enough to
  matter, build it concurrently instead, outside the transaction:
  ```sql
  -- run separately, NOT inside the migration transaction
  CREATE INDEX CONCURRENTLY "audit_log_rate_limit_idx"
  ON "audit_log" USING btree ("ip_hash", "event", "occurred_at")
  WHERE "ip_hash" IS NOT NULL;
  ```
  then delete that statement from the migration file before running it.

**`ALTER TYPE … ADD VALUE` inside a transaction** is permitted on PostgreSQL 12+
(Neon is well past that) provided the new values are not *used* in the same
transaction. They are not — no statement in 0017 writes an audit row.

### 3.2 Rehearse

```bash
# 1. Development first.
npm run db:migrate
npm run test:phase5:db      # 40+ DB invariant checks; refuses to run on production

# 2. Then a throwaway copy, applying 0015 → 0017 in sequence.
npm run rehearse:migration
```

`verify-phase-5-db.mts` fingerprints the target and **exits rather than run
against production**. It proves the single-slot index, the two-admin trigger,
atomic invite redemption under concurrency, and webhook idempotency.

### 3.3 Apply to production

Use the project's existing gated path. Do **not** run `drizzle-kit migrate`
against production by hand.

```powershell
# All THREE are required. The gate refuses a half pair, a swapped pair, or two
# strings from different branches — see §3.4.
$env:DATABASE_URL          = "<production POOLED string>"
$env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"
$env:PRODUCTION_POOLED_URL = "<production POOLED string>"

node scripts/verify-migration-target.mjs --expect-migrations=16   # must print GO
npm run db:migrate
```

### 3.4 What the gate now refuses

Hardened in this pass. Every one of these is a **NO-GO**, not a warning, and the
gate stops before opening a connection:

| Condition | Why it is fatal |
|---|---|
| `DATABASE_URL` unset | Nothing cross-checks the string drizzle-kit will open. |
| `DATABASE_URL_UNPOOLED` unset | drizzle-kit falls back to the pooler; DDL over a pooler can fail part-applied. |
| The two are swapped | Two nearly identical URLs differing by seven characters — the easiest mistake at this step. |
| The two are on different Neon endpoints | **The accident this gate exists for**: `.env.local` supplying a development direct string beside a production pooled one. |
| `PRODUCTION_POOLED_URL` unset or a different database | Nothing anchors the target to what the deployed app is using. |
| The target is the known development database | Named explicitly now, instead of surfacing only as "not anchored". |
| A UTF-8 BOM in `.env.local` | Node's `--env-file` parser does not strip it, so the FIRST variable is set under an unreadable name — `DATABASE_URL` reads as `undefined` while a dump of the environment shows it present. Under `DATABASE_URL_UNPOOLED ?? DATABASE_URL` that silently selects a different database. `npm run test:env` proves the refusal. |

No message from this tooling ever contains a connection string, hostname,
username or password; databases are named by fingerprint. That is asserted, not
intended — `scripts/verify-env-safety.mjs` §E.

Then confirm:

```sql
select count(*) from drizzle.__drizzle_migrations;   -- expect 18
select to_regclass('public.admin_backup');           -- not null
select tgname from pg_trigger where tgname = 'users_max_two_admins';
```

---

## 4. Set the remaining environment variables

Production only, all **Sensitive**:

```
INVITE_CODE_PEPPER      = <32+ random chars, e.g. `openssl rand -base64 48`>
CRYPTO_PAYMENTS_ENABLED = false
```

Do **not** set `CRYPTO_PAYMENT_PROVIDER` or `MOCK_PAYMENT_WEBHOOK_SECRET`. With
the flag false and no provider, the webhook endpoint returns 404 and no invoice
can be created.

> **Rotating `INVITE_CODE_PEPPER` invalidates every outstanding invite.** Set it
> once, before issuing any invite. If it is ever rotated, every unredeemed code
> stops working and cannot be recovered — issue replacements.

### 4.1 Confirm the Blob store is private-capable

`BLOB_READ_WRITE_TOKEN` is not new, but what it must point at is. Product media
is now uploaded with `access: 'private'`, and `finalizeUploadAction` **deletes**
any object that did not land on `*.private.blob.vercel-storage.com` rather than
recording it.

- If the store supports private objects: uploads work, and nothing in the
  catalog is world-readable.
- If it does not: the first upload fails with *"That upload was stored publicly
  and has been removed"* and the object is deleted. **Nothing degrades to
  public** — this is a fail-closed error, not a silent fallback.

Verify by uploading one image through `/admin/media` **after** the deploy and
before adding a catalog. Production's catalog is empty today, so there is
nothing to migrate; see `MEDIA-PRIVACY.md` §5 for the procedure if that ever
stops being true.

Verify: `/api/health/internal` should report
`"inviteCodesConfigured": true, "mediaStorageConfigured": true,
"checkoutEnabled": false, "cryptoPaymentsEnabled": false`.

`mediaStorageConfigured: false` means `BLOB_READ_WRITE_TOKEN` is missing, and
**every product image on the site will be broken** — media is streamed from
private storage using that credential. It is not a new variable, but it is newly
required for READS as well as uploads.

---

## 5. Deploy

Ordinary Vercel deploy of the merged branch.

**Order matters: migration first, then deploy.** The new code queries
`invite_codes` and `admin_backup` on the sign-up and admin paths; deploying
before migrating gives 500s on those routes.

The reverse (migrate, then deploy later) is safe — the new tables are simply
unused.

---

## 6. Post-deploy verification

Run these in order. **Stop at the first failure and roll back (§7).**

### 6.1 The login wall

Anonymous, no cookie:

```bash
for p in / /shop /product/anything /bag /checkout /account /admin /orders/CM-1; do
  echo -n "$p -> "
  curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://<prod>$p"
done
```

Every one must be a **307 to `/sign-in`**. Any 200 is a login-wall breach —
roll back.

Then confirm the public pages still work (expect 200):
`/sign-in`, `/sign-up`, `/forgot-password`, `/forgot-password/sent`.

### 6.2 The health split

```bash
curl -s https://<prod>/api/health          # 200, {"status":"ok","timestamp":…} ONLY
curl -s https://<prod>/api/health/internal # 401, empty body
```

The public response must **not** contain `environment`, `fingerprint`,
`latencyMs` or `scheduler`. If it does, the old handler is still deployed.

### 6.3 Admin access

1. Sign in as the owner → `/admin` renders, and a **Security** tab is visible.
2. `/admin/security/admin-access` shows your email under *Owner*.
3. `/admin/invites` renders with no "not configured" banner.
4. Sign in as any customer → `/admin` returns **403**, not a redirect.

### 6.4 Invite round trip

1. `/admin/invites` → create an invite, max uses 1. **Copy the code.**
2. Reload the page. The code shows masked (`CM-XXXX-••••-…`) and is not
   recoverable.
3. In a private window, `/sign-up` without a code → refused.
4. With a wrong code → *"That invite code is invalid or no longer available."*
5. With the real code → account created, `role = 'customer'`.
6. Reuse the same code → refused with the identical message.

```sql
-- must return exactly one row, role 'customer'
select u.role, r.redeemed_at
from invite_code_redemptions r join users u on u.id = r.user_id
order by r.redeemed_at desc limit 1;
```

### 6.5 Existing users are unaffected

Sign in as a pre-existing customer. They must **not** be asked for an invite
code. Invite enforcement applies to new registrations only.

### 6.6 Media privacy

```bash
# Anonymous. Must be 401 with an empty body — never 200, never HTML.
curl -s -o /dev/null -w "%{http_code}\n" "https://<prod>/api/media/00000000-0000-0000-0000-000000000000"
```

Then, signed in as the owner:

1. `/admin/media` → upload one image. It must succeed. A failure saying *"That
   upload was stored publicly and has been removed"* means the Blob store is not
   private-capable — stop and fix the store (§4.1).
2. Open the product page that image is on and **view source**. It must contain
   `/api/media/` and must NOT contain `blob.vercel-storage.com`.
3. No asset in `/admin/media` shows a **Public URL** badge.

### 6.7 Purchase limits and privileges

```bash
npm run verify:privileges
```

Then confirm in `/admin/purchase-limits` that the live rule set is exactly what
it was before the release. **Nothing in Phase 5 touches purchase-limit rules**;
this is a check that nothing did so by accident.

---

## 7. Rollback

### Code
Vercel → Deployments → previous deployment → **Promote to Production**. The
login wall, invite gate and admin guard all disappear with it. The new tables
remain and are simply unused.

### Environment
Removing `CLOUDMARKET_OWNER_USER_ID` under the NEW code denies every
administrator. Under the OLD code it is ignored. So roll the code back first,
then the variables — never the other way round.

### Migration
0017 is additive, so **rolling it back is not normally necessary and is not
recommended**. If it is genuinely required:

```sql
DROP TRIGGER IF EXISTS users_max_two_admins ON users;
DROP FUNCTION IF EXISTS cloudmarket_enforce_max_two_admins();
DROP INDEX IF EXISTS audit_log_rate_limit_idx;
DROP TABLE IF EXISTS payment_events, payment_intents;
DROP TABLE IF EXISTS invite_code_redemptions, invite_codes;
DROP TABLE IF EXISTS admin_backup;
DROP TYPE IF EXISTS payment_intent_status, payment_intent_method, payment_provider;
-- then delete the 0017 row from drizzle.__drizzle_migrations
```

**The 16 added `audit_event` enum values cannot be removed** — PostgreSQL has no
`ALTER TYPE … DROP VALUE`. They are harmless if unused. This is why the rollback
is "leave it in place" unless something is genuinely broken.

**Dropping `invite_codes` destroys the record of which invite created which
account.** Take a dump first.

---

## 8. Locked out? (owner recovery)

If `/admin` returns 403 for the owner, the cause is one of four things. Diagnose
with `/api/health/internal` (bearer `CRON_SECRET`) and:

```sql
select id, role, status, deleted_at from users where id = '<owner-uuid>';
```

| Symptom | Cause | Fix |
|---|---|---|
| `ownerIdentityConfigured: false` | variable unset or malformed | fix in Vercel, redeploy |
| configured `true`, still 403 | id does not match any user | re-read §2.1 |
| `role <> 'admin'` | role was changed | `update users set role='admin' where id='<uuid>'` |
| `status <> 'active'` | account suspended | `update users set status='active' where id='<uuid>'` |

Audit rows named `OWNER_IDENTITY_MISCONFIGURED` and `ADMIN_ACCESS_DENIED` record
every refusal with its reason.

There is **no application path** back in — by design. Recovery is a SQL
statement or an environment change, both of which require credentials an
attacker who compromised a session would not have.

---

## 9. Deliberately NOT part of this rollout

- **`CHECKOUT_ENABLED` stays `false`.** Unchanged by this release.
- **`CRYPTO_PAYMENTS_ENABLED` stays `false`.** The architecture ships inert.
  Enabling it needs a provider adapter that does not exist yet, plus its own
  approval.
- **No production reseed, no reset, no purchase-limit changes.**
- **No change to `cloudmarket_app` privileges.**
- **CSP is Report-Only for scripts.** See §10.

> **Media privacy is now RESOLVED, and it changed this release.** Uploads are
> written `access: 'private'` and every asset is served through the
> authenticated `/api/media/<id>` route. `MEDIA-PRIVACY.md` records the design,
> its costs, and the one operational precondition: **the Blob store must support
> private objects**, or uploads fail closed. See §4.1.

---

## 10. Follow-up: promote the CSP

The enforced policy currently covers only directives that cannot break rendering
(`frame-ancestors`, `object-src`, `base-uri`, `form-action`,
`upgrade-insecure-requests`). The full nonce-based `script-src`/`style-src`
policy ships as **`Content-Security-Policy-Report-Only`**.

After ~1 week of production traffic:

1. Collect violation reports (browser console, or wire up a `report-uri`).
2. If clean, in `proxy.ts` → `withSecurityHeaders`, set the `reportOnly` value
   under the `Content-Security-Policy` header name instead.
3. **Before doing so**, confirm no route is statically prerendered — a
   build-time-rendered page carries no nonce and its scripts will be blocked.
   `npm run build` currently shows `/forgot-password`, `/forgot-password/sent`
   and `/_not-found` as static (`○`). Add `export const dynamic = 'force-dynamic'`
   to those pages first.

---

## 11. Sign-off checklist

- [ ] §1 preconditions verified, production at 16 journal rows
- [ ] Owner user id read from production and confirmed `admin` + `active`
- [ ] `CLOUDMARKET_OWNER_USER_ID` set, Sensitive, Production-scoped only
- [ ] Not more than two `role = 'admin'` accounts
- [ ] 0017 rehearsed on development **and** on a throwaway copy
- [ ] `npm run test:phase5:db` green against development
- [ ] `INVITE_CODE_PEPPER` set; `CRYPTO_PAYMENTS_ENABLED=false`
- [ ] Migration applied to production; journal shows 18 rows
- [ ] Code deployed **after** the migration
- [ ] §6.1 login wall — every protected path 307s
- [ ] §6.2 public health returns status + timestamp only
- [ ] §6.3 owner reaches `/admin`; a customer gets 403
- [ ] §6.4 invite round trip, including reuse refused
- [ ] §6.5 an existing customer signs in without an invite
- [ ] §6.6 media is 401 anonymously; a page carries no storage address
- [ ] §6.7 privileges and purchase-limit rules unchanged
- [ ] `MEDIA-PRIVACY.md` read; the Blob store confirmed private-capable
