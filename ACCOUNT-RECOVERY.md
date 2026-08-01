# Email Verification & Password Recovery (Phase 3.5)

Branch `feat/account-recovery`. Development only — migration 0007 is applied to
the development branch, production remains on 0006. **No provider account, no
credential, and no email has been sent anywhere.**

---

## 1. Schema and migration

**`0007_cloudy_kulan_gath.sql`** — additive only, nothing rewritten.

| Change | Detail |
| --- | --- |
| 8 new `audit_event` values | `EMAIL_VERIFICATION_REQUESTED`, `EMAIL_VERIFIED`, `EMAIL_VERIFICATION_FAILED`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`, `PASSWORD_RESET_FAILED`, `SESSIONS_REVOKED`, `EMAIL_SEND_FAILED` |
| 1 new column | `verification_tokens.superseded_at` |
| 1 new index | `verification_tokens (user_id, purpose, created_at)` |
| Tables created | **none** — `verification_tokens` already existed from Phase 1 |

Everything else was already there: the table, the `token_purpose` enum, hashed
storage, `expires_at`, and single-use `consumed_at`. Phase 1 built the
substrate; this phase supplied delivery and the flows around it.

**`superseded_at` is separate from `consumed_at` on purpose.** Folding them
together would make "the customer clicked their link" and "the customer asked
for a second link" indistinguishable afterwards, and those mean very different
things when reading a security log. A token is usable only while all three hold:
not consumed, not superseded, not expired.

**One-way step:** `ALTER TYPE … ADD VALUE` cannot be reversed. Same caveat as
0006 — eight inert labels, and recreating the type to remove them would be far
riskier than leaving them.

---

## 2. When email is dispatched

| Trigger | Sends |
| --- | --- |
| Sign-up completes | Verification email, automatically, from  |
|  resend button | Verification email, manual fallback |
|  submit | Reset email, from  |

Sign-up dispatches after the response, so a slow or unreachable provider cannot
delay account creation and cannot fail it. Someone who has just passed the age
gate and had a password hashed ends up with an account whatever the provider is
doing; the email is a follow-up, not a precondition.

The automatic send starts the 60-second cooldown, so pressing resend immediately
is refused — correct, and the behaviour a customer actually meets, since
 is one click from where they land. If delivery fails the
token is discarded, which hands the cooldown and the daily budget straight back.

 lives in  behind , not in
a  module. It takes a userId and an address; exported as a Server
Action it would let any caller mail a verification or reset link for an arbitrary
account to an arbitrary address — a phishing primitive wearing our sending
domain. Same boundary as .

---

## 3. GET is inert — POST changes state

**No security-sensitive state change happens on a GET.** A URL in an email is
opened by things that are not the customer: corporate mail security following
every link, antivirus appliances, link-preview bots, browser prefetchers. Every
one of them issues a GET; none of them submits a form.

| Route | GET does | POST does |
| --- | --- | --- |
| `/verify-email/[token]` | Inspects the token and renders a **Confirm** button. No consumption, no `email_verified_at`, no audit event implying an account changed. | Consumes atomically, sets `email_verified_at`, audits `EMAIL_VERIFIED`, redirects to `/sign-in?verified=1`. |
| `/reset-password/[token]` | Renders the form. No consumption, no password change, no session revocation. | Consumes atomically, writes the password, revokes every session, audits, redirects to `/sign-in?reset=done`. |

Both POSTs are ordinary HTML forms and work with JavaScript disabled.

Verification originally consumed on GET, and the hardening review was right to
reject it. A scanner would have confirmed addresses on behalf of people who
never clicked, and the customer would then arrive at a spent link for an account
something else had already "confirmed". Now tested with five GETs from distinct
user agents before the POST, asserting the token is still unconsumed and the
account still unverified afterwards.

Re-opening a spent verification link reports **already confirmed** rather than a
failure — the address genuinely is confirmed, and that is the truthful thing to
say.

---

## 3. Token lifecycle

```
issueToken(userId, purpose)
  ├── supersede every outstanding token for (user, purpose)   ← one canonical link
  ├── randomBytes(32) → base64url                             ← the raw token
  ├── store sha256(token) only
  └── return the raw token, used once to build a link, then gone

claimTokenWithin(tx, rawToken, purpose)          ← runs inside the caller's transaction
  └── UPDATE ... SET consumed_at = now()
       WHERE token_hash = $1 AND purpose = $2
         AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now()
     RETURNING user_id

inspectToken(rawToken, purpose)                  ← read-only, used by GET
```

| Property | How |
| --- | --- |
| Stored hashed only | SHA-256, 64 hex. Tested by recomputing the digest of the emailed token, and by asserting the raw value matches no row. |
| Raw token's lifetime | One function call. Never persisted, never logged, never audited, never returned by a read path. |
| Verification TTL | 24 hours |
| Reset TTL | 1 hour |
| One-time use | The UPDATE *is* the check. Two simultaneous POSTs cannot both win. |
| Purpose enforced | Part of every lookup — a verification token presented at the reset endpoint does not match. |
| Re-issue invalidates | Both purposes. A second reset request kills the first link. |

**Why SHA-256 and not scrypt.** Passwords are low-entropy and need a slow hash.
These tokens are 256 bits of CSPRNG output — there is no dictionary to try, and
a fast hash lets the lookup use the unique index instead of scanning.

---

## 4. Transaction boundaries and failure semantics

The security-critical mutations of each flow commit together or not at all.

**Password reset — one transaction:**

```
BEGIN
  claim the token   (conditional UPDATE; also the concurrency guard)
  write the new password hash, clear lockout state
  DELETE every session for the user
COMMIT
→ audit SESSIONS_REVOKED, PASSWORD_RESET_COMPLETED
→ redirect /sign-in?reset=done
```

**Email verification — one transaction:**

```
BEGIN
  claim the token
  set email_verified_at WHERE email_verified_at IS NULL
COMMIT
→ audit EMAIL_VERIFIED
→ redirect /sign-in?verified=1
```

**Why session revocation is inside the reset transaction.** If the password
write committed but revocation did not, an intruder's session would survive a
reset performed specifically to evict them — the one outcome this flow exists to
prevent. It is not a tidiness concern; it is the whole point.

**scrypt runs before `BEGIN`.** Hashing is deliberately slow, and holding a
transaction open across it would pin a connection and widen the window in which
the user row is locked, for no benefit.

### Failure semantics

| Failure point | Result |
| --- | --- |
| Anywhere inside the transaction | Full rollback. Token **unconsumed**, password unchanged, sessions intact. The customer's link still works and retrying is safe. |
| After commit, before audit | The mutation stands and one audit row is missing. Accepted: the alternative is letting a logging failure roll back a completed password change, which is worse. Audit writes are a single insert with no dependencies and have not failed in any run. |
| Provider delivery, after the response | See §8. |

The customer-facing message on rollback says so explicitly: *"Something went
wrong. Your reset link still works — please try again."*

**This is tested, not asserted.** `RECOVERY_FAULT_INJECTION=after_consume` opens
a seam that throws immediately after the token is claimed, scoped per-request by
an `x-recovery-fault` header so the rest of the suite is unaffected, and inert in
production. The suite then proves the token is unconsumed, the password
unchanged, and the link still usable.

---

## 5. Anti-enumeration

The reset request has **one outcome**: `redirect('/forgot-password/sent')`. Real
address, unknown address, suspended account, throttled request, and even a
malformed address all take it. Not similar responses — the same response, same
status, same location.

**Timing is part of it.** Everything that could differ happens inside Next's
`after()`, which runs once the response is already on its way. The lookup, the
token write and the provider call all happen after the redirect, so "no account"
and "account found, token issued, mail sent" cannot be told apart with a
stopwatch. `after()` rather than a floating promise, because it is the supported
way to keep work alive past the response without the platform killing it.

The confirmation page says *"If an account exists for that address, we've sent a
link"*. The vaguer "we've sent you an email" would be a lie in the cases where
nothing was sent. Stating the condition tells the truth and still leaks nothing.

**Where specificity is safe, it is used.** The signed-in resend page names the
address and says exactly how many seconds to wait, because the visitor already
proved they hold that account.

---

## 6. Token URL exposure

The token has to travel in the URL — it arrives by email and there is nowhere
else to put it. Everything downstream of that is controlled:

| Control | Where |
| --- | --- |
| `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` | `proxy.ts`, for `/verify-email/` and `/reset-password/` |
| `Referrer-Policy: no-referrer` | `next.config.ts` + `proxy.ts` |
| `X-Robots-Tag: noindex, nofollow, noarchive` | `next.config.ts` |
| No third-party scripts, images, fonts or analytics on either page | asserted in the suite |
| Token never logged, never in audit metadata, never in client telemetry | asserted in the suite |
| Redirect to a clean URL after consumption | `/sign-in?verified=1`, `/sign-in?reset=done` |

**`Cache-Control` is set in `proxy.ts`, not `next.config.ts`.** Next owns that
header for App Router pages and overwrites what the config says; the dev server
returns `no-cache, must-revalidate`, which still permits storing. Setting it on
the response as it leaves is the only place the value survives. The production
build is where `no-store` is observable, so that assertion lives in the
production-build suite (`verify-auth-e2e.mjs` §9b) rather than the dev-server
recovery suite.

**None of this makes the URL secret.** Browser history, proxy logs and corporate
TLS inspection can still record it. That is precisely why the TTL is short and
the token single-use: exposure is assumed, and what is being minimised is how
long it matters.

---

## 7. Throttling

Per account, per purpose, computed from rows the system already writes — no
Redis, no rate-limit table.

| Limit | Value |
| --- | --- |
| Minimum gap between sends | 60 seconds |
| Maximum sends per rolling 24h | 5 |

`verification_tokens (user_id, purpose, created_at)` is the index that makes it
one query. Because the limit follows the **account**, an attacker rotating
source addresses still cannot mail any one person more than 5 times a day.

A throttled *reset* request is silently not sent — saying "you already requested
one" would confirm the address exists. A throttled *resend* says plainly how
long to wait, for the reason in §3.

**Not covered, and deliberately so:** aggregate volume across many different
addresses. That is a provider-quota concern rather than an account-security one,
and the fix is IP-scoped limiting, which needs a shared store. Recorded as
production hardening in §14 rather than shipped ahead of evidence.

---

## 8. Session handling

| Event | Sessions | New session? |
| --- | --- | --- |
| **Password reset** | **All revoked**, including the one completing the reset | **No** — redirect to `/sign-in?reset=done` |
| **Password change** (signed in) | All others revoked, current kept | n/a |
| **Email verification** | Untouched | n/a |

Reset is the remedy for "someone else may be in my account", and it is worth
nothing if the intruder's cookie outlives it. No replacement session is created
because completing a reset proves control of the mailbox, not knowledge of the
old password — requiring a fresh sign-in keeps "every session was destroyed"
true without an immediate exception carved into it.

Ordering and atomicity are covered in §4: the claim, the password write and the
revocation are one transaction, so none of them can land without the others.

Verification does not touch sessions — confirming an address is not an
authentication event.

---

## 9. Account state

New accounts stay `status = 'active'` with `email_verified_at` null.

```
active   + verified_at null  → sign in, browse, keep a bag; no ordering
active   + verified_at set   → full customer
suspended                    → nothing, regardless of verification
```

Verification is recorded in exactly one place. `status` answers "may this
account be used at all"; `email_verified_at` answers "has this address been
confirmed". Encoding the second fact in both columns would invite them to
disagree. `pending_verification` remains in the enum, unused.

---

## 10. Provider abstraction

```
lib/email/
  types.ts       EmailTransport, EmailMessage, EmailResult
  index.ts       selection + the fail-closed rule
  resend.ts      REST, via fetch — NO SDK dependency
  console.ts     development: prints the link to the terminal
  capture.ts     tests: appends to a file
  templates.ts   the two messages, HTML + text
```

Nothing outside `lib/email/` imports a provider, and no provider type appears in
`types.ts`. Swapping to Postmark is one new file plus one line in `index.ts`.

**Zero new dependencies.** Resend's API is one authenticated POST with a JSON
body, and `fetch` is built in. A package to construct that request would put a
vendor's transitive dependencies on the path of every password reset and would
not have made the provider any more replaceable — the interface does that.

**Delivery failures are returned, never thrown**, so a transport outage cannot
surface as a 500 on a page where a 500 would itself leak which addresses exist.
The caller records `EMAIL_SEND_FAILED` and shows a retry-able message.

### Fail-closed

```
NODE_ENV=production + EMAIL_PROVIDER anything but 'resend'  → refuses to send
NODE_ENV=production + resend without key/from               → refuses to send
```

There is no fallback to console in production. A deployment that quietly printed
reset links to a server log would look healthy while customers waited for mail
that was never sent — and every one of those links, each a live credential,
would be sitting in a log aggregator.

The refusal is at **send** time, not import time: a missing email key must not
stop the storefront from booting, because browsing, the bag and sign-in do not
need email.

---

## 11. Accessibility and no-JS

Every flow is a plain `<form>` posting to a Server Action, and the entire
journey works with JavaScript disabled:

```
sign up → verification prompt → resend → click link → result
forgot password → generic confirmation → click link → set password → sign in
```

- `autocomplete="new-password"` on both reset fields, so password managers offer
  to save correctly.
- Minimum length stated **before** submission, not discovered by failing.
- Errors use `role="status"` beside the control that caused them.
- Success and failure are words, never colour or icon alone.
- Email HTML: semantic headings, meaningful link text, a real `text/plain`
  alternative, no remote images, no tracking pixel, and the raw URL always
  printed under the button.

**One deliberate tension.** The reset form gives identical feedback whether or
not the address exists, which is worse for someone who simply mistyped. The copy
compensates by being explicit rather than vague — it states the condition, sets
the expectation, and points at the spam folder.

### The confirmation route lives outside `/account`

`/verify-email/[token]`, not `/account/verify-email/[token]`. The proxy bounces
every `/account/*` request without a session cookie, and someone confirming from
their phone's mail app usually has no session there. This was caught by the E2E
suite — the link worked in a browser that happened to be signed in and failed
everywhere else.

**Verification consumes on GET; reset does not.** A verification link has no
follow-up step to attach the write to, so asking someone to click a link and
then press a button to confirm they clicked it is friction for nothing. The
reset link lands on a form and consumes in the POST, which is what keeps a link
scanner from burning it. For verification the scanner case is handled instead:
if the token was already consumed and the account is verified, the page reports
success, because the address genuinely is confirmed.

---

## 12. Security review

| Concern | Handling |
| --- | --- |
| **Host-header link forgery** | Links are built from `NEXT_PUBLIC_APP_URL`. `Host` and `X-Forwarded-Host` are attacker-controlled; a reset link assembled from them would deliver a live credential to a domain of the attacker's choosing, inside a genuine email from us. The request's opinion of its own hostname is never in scope. |
| Token disclosure at rest | SHA-256 only. A database dump yields nothing replayable. |
| Token in logs | Asserted: no audit summary contains a token, password, URL, or an address. |
| Token URL exposure | See §6 — no-store, no-referrer, no third-party assets, clean redirect after use. |
| GET side effects | None. See §2. |
| Partial mutation | Impossible: §4, proven by fault injection. |
| Token replay | Atomic single-use, plus supersession on re-issue. Verified under concurrency: exactly one of two simultaneous POSTs succeeds. |
| Cross-purpose replay | `purpose` is part of every lookup. |
| Account enumeration | §3, including timing. |
| Audit as an enumeration oracle | `PASSWORD_RESET_REQUESTED` is written for unknown addresses with `user_id` NULL and **nothing identifying** — no summary, no entity id. The log shows reset traffic exists without becoming the oracle the response refuses to be. |
| IP / user-agent in audit | HMAC-SHA256 keyed with `AUTH_SECRET`, never plain. |
| Lockout interaction | A completed reset clears `failed_login_attempts` and `locked_until` — the account has been recovered. |
| Suspended accounts | Identical response, no email. |
| Debug inbox route | 404 unless non-production **and** capture transport selected. Verified: a production-mode server with `EMAIL_PROVIDER=capture` explicitly set still returns 404. |

**Residual risks, stated rather than hidden:**

1. No per-IP rate limiting (§4).
2. A verification link consumed by a mail scanner is spent; the page reports
   success correctly, but the customer never sees the "just verified" state.
3. Reset emails go to the address on file; there is no change-of-address flow,
   which is deliberately out of scope.

---

## 13. Test results

```
npm run test:recovery   116 passed, 0 failed   (dev server, EMAIL_PROVIDER=capture,
                                                RECOVERY_FAULT_INJECTION=after_consume)
npm run test:email       12 passed, 0 failed   (transport config, process-isolated)
npm run test:e2e         94 passed, 0 failed   (regression, production build)
npm run test:bag         63 passed, 0 failed   (regression, production build)
npm run test:auth        28 passed, 0 failed   (regression)
lint                     0 errors, 1 pre-existing warning
typecheck                clean
build                    clean
```

Without the fault-injection seam enabled the recovery suite reports 112 and
skips the four atomicity assertions, saying so rather than passing silently:

```
skipped: run with RECOVERY_FAULT_INJECTION=after_consume on the server
```

### Hardening coverage

| Requirement | Assertion |
| --- | --- |
| Scanner GET does not verify | 5 GETs from distinct agents, then `email_verified_at` still null |
| Repeated verification GET does not consume | `consumed_at` still null after 5 GETs |
| Verification POST consumes exactly once | replayed POST rejected; `email_verified_at` unmoved |
| Reset GET does not consume | `consumed_at` and `superseded_at` both null after 5 GETs |
| Repeated reset GET does not invalidate | sessions intact, old password still works after the GETs |
| Reset POST consumes exactly once | replay rejected, password unchanged by the replay |
| Forced failure between consume and password write | token unconsumed, password unchanged, link still usable |
| Concurrent verification POSTs | exactly one succeeds; exactly one consumed row |
| Concurrent reset POSTs | exactly one succeeds |
| Consumption redirects away from the token URL | `Location` carries no token |
| Responses are `no-store` | production build, `verify-auth-e2e.mjs` §9b |
| `Referrer-Policy: no-referrer` | both suites |
| No raw token in audit or logs | no summary contains a token, password, URL or `@` |
| Provider failure observable without enumeration | `EMAIL_SEND_FAILED` present, carrying no address and no token |

### Harness discipline

Every row the suites create is captured by id at creation and deleted by id.
There are no shape-based deletes anywhere — no time windows, no `WHERE event =
…`. Pre-existing audit rows are snapshotted and asserted to survive.

### Three bugs the suites caught

**The capture transport did not work.** It was an in-memory array, but a Server
Action and a Route Handler are separate bundles with separate module instances —
the action pushed into one array while the debug route read a different, always
empty one. Now a newline-delimited file, which is the boundary both sides share.

**The confirmation link was unreachable without a session.** It sat under
`/account`, which the proxy bounces when there is no session cookie — the normal
case for a phone's mail app. Moved to `/verify-email/[token]`.

**`Cache-Control` was silently overridden.** Set in `next.config.ts` it looked
correct and was replaced by Next's own value for App Router pages. Caught by the
header assertion, moved to `proxy.ts`.

---

## 14. Production rollout requirements

**Not started. Nothing below has been done.**

1. **Rotate the DEVELOPMENT Neon credential.** Exposed repeatedly during
   debugging, including once by this assistant printing a connection string to
   its own console. Not a production incident — the dev branch holds seed data
   and cannot reach production — but it should be rotated before this phase
   ships. Requires Neon console access, which the assistant does not have.
   Afterwards: restore `.env.local` with the new development strings, confirm
   the old credential is rejected, and confirm the new one cannot reach
   production. Neither string should be pasted into chat.
2. **Choose and verify a sending domain** — SPF and DKIM, plus a real monitored
   `EMAIL_REPLY_TO`.
3. **Create the Resend API key** and set, in Vercel **Production only**, marked
   Sensitive: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`,
   `EMAIL_REPLY_TO`. Preview must stay without them — it has no `DATABASE_URL`
   either and is fail-closed by construction.
4. **Confirm `NEXT_PUBLIC_APP_URL`** is the canonical public origin. Every link
   in every email is built from it, never from a request header.
5. **Apply migration 0007 before deploying the code**, through the same gated
   sequence as 0005/0006: `verify-migration-target.mjs` → `GO` →
   `drizzle-kit migrate` → confirm. Code-first would fail on the first audit
   insert, because the enum values would not exist.
6. **Confirm `RECOVERY_FAULT_INJECTION` is unset in production.** It is inert
   there regardless — the seam checks `NODE_ENV` first — but it should not be
   present.
7. **Smoke-test delivery** with Resend's `delivered@resend.dev` and
   `bounced@resend.dev` before pointing a real customer at it.
8. **Then** decide on IP-scoped rate limiting (§7) — a Postgres bucket table is
   preferred over adding a vendor.

**Out of scope, unchanged:** checkout, orders, payments, 2FA, magic links,
OAuth, email-address change, marketing email, bounce/webhook processing.
