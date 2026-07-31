# Authentication and authorization

Phase 1. Email + password, database-backed sessions, three roles.

Consumes the frozen design system unchanged — every screen here sits at 10%
brand intensity per [DESIGN.md](./DESIGN.md) §9.

---

## 1. The architectural decision worth reviewing

**Sessions are rows in Postgres, not JWTs — and Auth.js is not in the request
path.**

`next-auth@5.0.0-beta.32` and `@auth/drizzle-adapter` were installed in Phase 0,
and this phase does not use them. The reason is specific rather than
stylistic:

- Auth.js's **Credentials provider only supports JWT sessions.** This is a
  documented limitation, not a configuration mistake. Database sessions require
  an OAuth or email provider.
- No OAuth credentials and no transactional email provider are configured, so
  Credentials is the only usable provider today — which forces JWT.
- A JWT session **cannot be revoked**. It is valid until it expires, whatever
  happens in between. For a licensed cannabis retailer, "we cannot end that
  session for another 30 minutes" is not an acceptable answer to an account
  takeover or a staff offboarding.
- The usual mitigation — a `tokenVersion` column checked on every request —
  reintroduces the database read that JWTs exist to avoid, and adds a failure
  mode where a missed check silently keeps a revoked session alive.

So sessions are rows. One indexed lookup per request buys instant revocation,
a visible device list, and per-session audit data. `next-auth` stays in
`package.json` for OAuth in a later phase, where it is genuinely the right tool.

**This is the decision to overturn if you disagree with it.** Everything else
here is ordinary.

---

## 2. Authorization model

Next 16's own guidance is explicit that Proxy must **not** be the authorization
solution: it runs on prefetches, cannot safely touch the database, and any path
that reaches a Server Component another way would bypass it.

So there are two layers, and only one of them is a security boundary:

| Layer | File | Role |
| --- | --- | --- |
| **Proxy** | `proxy.ts` | *Optimistic only.* Checks whether a session cookie is **present**. Never decodes or validates it. Pure UX — bounces anonymous visitors before a protected shell renders. |
| **Data Access Layer** | `lib/auth/dal.ts` | **The security boundary.** Resolves the session against the database, enforces role and verification. Every protected read and every Server Action goes through it. |

A forged cookie sails past Proxy and is rejected by the DAL. That is by design.

### DAL surface

```
getCurrentSession()   session + user, or null      — no redirect
getCurrentUser()      user, or null                — no redirect
requireSession(next?) redirects to /sign-in
requireUser(next?)    redirects to /sign-in
requireVerifiedUser() redirects to /account/verify-email
requireRole(...roles) 403 via forbidden()
requireStaff()        staff | admin
requireAdmin()        admin
hasRole(...roles)     boolean — for hiding UI, NOT for protection
```

`getCurrentSession` and `getCurrentUser` are wrapped in React `cache`, so a
layout, its page, and any number of leaf components share exactly one session
lookup per render. The `require*` guards are deliberately **not** cached:
they perform no database work of their own — the lookup they delegate to is
already deduplicated — and memoising a function whose result is a thrown
navigation interrupt buys nothing.

`hasRole()` hides a control. It does not protect the action behind it — every
Server Action re-checks with `requireRole`.

**Auth checks never live in layouts.** Layouts do not re-render on navigation
under partial rendering, so a guard there goes stale between route changes.
`app/account/layout.tsx` reads the user to render a header; each page calls
`requireUser()` itself.

### Roles

A fixed ladder, not a permission matrix. Three is enough for the whole roadmap,
and a matrix nobody needs yet is a liability rather than flexibility.

| Role | Can |
| --- | --- |
| `customer` | Shop, manage own account and orders |
| `staff` | Fulfil and dispatch orders. No pricing, no user administration |
| `admin` | Everything, including roles |

Role changes revoke the target's sessions immediately, so a demotion takes
effect on the next request rather than whenever their session happens to lapse.

---

## 3. Security properties

| Concern | How it is handled |
| --- | --- |
| Password storage | scrypt, N=2¹⁵ r=8 p=1, 16-byte salt, parameters encoded in the hash so the cost can be raised later without invalidating existing hashes. Node built-in — no native dependency, nothing to rot in the supply chain. |
| Password comparison | `timingSafeEqual`, with an explicit length check first because it throws on mismatch. |
| User enumeration — login | One message for *every* failure: absent account, wrong password, locked, suspended. |
| User enumeration — timing | A missing account still burns one scrypt's worth of time (`equalizeTimingForMissingUser`). |
| Brute force | 5 failed attempts → 15-minute lockout, counted **per account**, because credential-stuffing rotates IPs. |
| Session tokens | 256 bits from the CSPRNG, base64url. Stored as SHA-256 — a database disclosure yields no usable sessions. |
| Session fixation | A fresh token is minted on every sign-in; an attacker-planted cookie is discarded. |
| Session lifetime | 7-day idle window, sliding. **30-day absolute cap** from `created_at`, so a session used daily cannot live forever. |
| Revocation | Delete the row. Instant. Password change revokes every *other* session. |
| Cookies | `httpOnly`, `sameSite=lax`, `secure` in production, and the `__Host-` prefix in production — which the browser refuses unless Secure + path=/ + no Domain, closing off subdomain cookie injection. |
| CSRF | Server Actions carry Next's built-in origin checks. No hand-rolled token needed. |
| Open redirect | `?next=` is constrained to same-origin paths by `safeRedirectPath`. Verified against 7 attack strings. |
| Suspension | Enforced on **session read**, not only at login — suspending someone takes effect immediately. |
| Age gate | 21+ (Michigan), calendar-correct, required at sign-up and re-checkable at order time. |

---

## 3.5 Session lifecycle

```
sign-in ──> createSession()
              │  fresh 256-bit token          (closes session fixation)
              │  SHA-256 stored, plaintext only in the cookie
              ▼
          session row  expires_at = now + 7d
              │
   each request ──> resolveSession()
              │      ├─ no row for token hash        ──> null
              │      ├─ expires_at <= now            ──> DELETE, null   (idle)
              │      ├─ created_at + 30d <= now      ──> DELETE, null   (absolute)
              │      ├─ user suspended / deleted     ──> DELETE, null
              │      └─ last_used_at older than 1h   ──> UPDATE
              │             last_used_at = now
              │             expires_at   = now + 7d  (slide)
              ▼
   sign-out / revoke / password change ──> DELETE row  (instant, no waiting)
```

- **Idle window** 7 days, sliding. Refreshed at most once an hour, so a busy
  session does not mean a database write per page view.
- **Absolute cap** 30 days from `created_at`, independent of activity. Without
  it, a session used daily lives forever and a single undetected token theft
  becomes permanent access.
- **Suspension is enforced on read**, not only at login, so suspending an
  account takes effect on that account's very next request.

## 3.6 Cookie strategy

| Attribute | Value | Why |
| --- | --- | --- |
| Name (production) | `__Host-cloudmarket_session` | The strongest prefix available — the browser rejects the cookie unless it is Secure, `Path=/`, and has **no** `Domain`. Closes off subdomain cookie injection entirely. |
| Name (development) | `cloudmarket_session` | `__Host-` requires HTTPS; without the fallback the cookie would silently fail to set on `http://localhost`. |
| `HttpOnly` | yes | JavaScript cannot read it, so XSS cannot exfiltrate the session. |
| `Secure` | production only | |
| `SameSite` | `Lax` | Blocks cross-site POST CSRF while keeping top-level navigation into the site signed in. |
| `Path` | `/` | Required by `__Host-`. |
| `Expires` | matches `expires_at` | |
| Rotation | new token on every sign-in | Session fixation: a planted cookie is replaced, never adopted. |

All seven verified against a production build — see `[2] Cookie configuration`
in the E2E output.

## 3.7 Revocation strategy

| Trigger | Effect |
| --- | --- |
| Sign out | Deletes the current session only |
| Revoke one device | Deletes that row, scoped to the owner so ids cannot be probed |
| Revoke all others | Deletes every row except the current one |
| Password change | Automatically revokes every *other* session |
| Suspension | Deletes all sessions, and read-time enforcement catches any survivor |
| Role change | Deletes all sessions, so a demotion cannot outlive the change |

The current session survives a password change on purpose: the user just proved
knowledge of both the old and the new password, so forcing an immediate re-login
is friction with no security benefit.

---

## 4. Audit log

Append-only, `audit_log`. Ten events, no UI — this is a record for
investigation and compliance, not a dashboard.

| Column | Notes |
| --- | --- |
| `occurred_at` | |
| `event` | enum, see below |
| `user_id` | `ON DELETE SET NULL` — deleting a user must not erase what happened to their account. Null for a failed login against an unknown address. |
| `session_id` | **Not** a foreign key. Sessions are deleted on logout and revocation, and the audit row has to outlive the thing it describes. |
| `ip_hash` | HMAC-SHA256 |
| `user_agent_hash` | HMAC-SHA256 |

Events: `ACCOUNT_CREATED` · `LOGIN` · `LOGOUT` · `FAILED_LOGIN` ·
`ACCOUNT_LOCKED` · `ACCOUNT_UNLOCKED` · `PASSWORD_CHANGED` · `PASSWORD_RESET` ·
`SESSION_REVOKED` · `ACCOUNT_SUSPENDED`

`PASSWORD_RESET` is defined but never emitted yet — the reset flow needs email.

### Why HMAC and not a plain hash

IPv4 is 2³² values. A plain SHA-256 of an IP address is reversible by
exhaustive search in seconds, so "hashing" it would be pseudonymisation in name
only — the log would be exactly as identifying as storing the address in clear,
while giving everyone who reads it false confidence. User-agent strings have
similarly low real-world entropy.

Keying the digest with `AUTH_SECRET` fixes that: the digest cannot be
brute-forced back to an address, while the same address still produces the same
value — so correlation ("these ten failed logins came from one place") keeps
working, which is the entire operational value of the field.

**Consequence:** rotating `AUTH_SECRET` breaks correlation with rows written
before the rotation. That is the correct trade, but plan rotations knowing it.

Audit writes never throw. Losing a log line is bad; refusing to authenticate a
legitimate customer because the log table is unavailable is worse.

---

## 5. Verification

```bash
npm run test:auth   # 28 assertions, no database required
npm run test:e2e    # 89 assertions against a real database
```

**`test:auth`** covers the functions where a mistake is a vulnerability rather
than a bug: hashing, salting, malformed-hash handling, unicode normalisation,
token entropy and uniqueness, the age gate at the exact 21st-birthday boundary,
and open-redirect rejection against seven attack strings.

**`test:e2e`** drives the real HTTP surface — the same Server Action endpoints a
browser posts to, submitted the way a browser with JavaScript disabled would.
It refuses to run against the production database. Coverage: account creation
and password storage, cookie attributes, session lifecycle including sliding
expiry and expiry cleanup, login success and failure, timing consistency,
logout, lockout and unlock, suspension, the full role ladder, two-device
revocation, revoke-all, and audit coverage.

### Bugs these caught

1. **`z.email()` validates before transforms**, so an address with a trailing
   space was rejected outright rather than trimmed. Normalisation now runs
   first.
2. **"Sign out all other devices" did not work without JavaScript.** The action
   was wrapped in an inline client-side arrow, so Next emitted no hidden action
   fields and the form silently did nothing — while every other form on the
   site degraded correctly. The action is now passed to `useActionState`
   directly.

### A note on status codes

When the DAL raises `redirect()` or `forbidden()` *after* Next has begun
streaming the response, the framework cannot set a 307/403 header and instead
embeds the navigation in the body — so the transport status is 200 while the
guarded component never renders. This was measured; it is framework behaviour,
not something the DAL controls, and removing the `cache()` wrappers did not
change it.

It is **not** a security weakness. The E2E suite therefore asserts on *content
denial* — using marker strings that appear only inside the guarded component —
rather than on status codes. Browsers follow the embedded navigation normally.

---

## 6. Known gaps

These are deliberate and scoped, not oversights.

1. **Email delivery is not configured**, so verification and password reset
   cannot send. The `verification_tokens` table, its `purpose` enum, and
   single-use `consumed_at` semantics are all in place; only delivery is
   missing. Sign-up therefore creates accounts as `active` with
   `email_verified_at` null — they can browse and build a bag, and
   `requireVerifiedUser()` will gate ordering in Phase 5.
2. **Password reset is not implemented**, for the same reason. It is the first
   thing to build once a provider exists.
3. **Sign-up reveals whether an email is registered.** Suppressing this properly
   requires sending a "you already have an account" email, which needs (1).
   Sign-*in* does not leak.
4. **No OAuth.** `next-auth` is retained for this.
5. **Lockout is per-account, in the database.** There is no per-IP edge rate
   limit; add one at the platform layer before launch if abuse appears.

---

## 7. Files

```
lib/auth/crypto.ts       scrypt hashing, token generation, timing equalisation
lib/auth/session.ts      create / resolve / rotate / revoke, cookie handling
lib/auth/dal.ts          the authorization boundary
lib/auth/validation.ts   zod schemas, age gate, safeRedirectPath
lib/auth/actions.ts      Server Actions
lib/db/schema/auth.ts    users, sessions, verification_tokens, enums
proxy.ts                 optimistic cookie check
app/(auth)/              sign-in, sign-up
app/account/             profile, security, verify-email
app/forbidden.tsx        403
app/unauthorized.tsx     401
```

`forbidden()` and `unauthorized()` require `experimental.authInterrupts`, which
is enabled in `next.config.ts` with its reasoning recorded there. The failure
mode if that API changes is a build-time import error — loud and impossible to
ship past — which is why it was an acceptable exception to this project's
otherwise conservative stance on experimental flags.
