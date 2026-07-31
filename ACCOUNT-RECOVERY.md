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

## 2. Token lifecycle

```
issueToken(userId, purpose)
  ├── supersede every outstanding token for (user, purpose)   ← one canonical link
  ├── randomBytes(32) → base64url                             ← the raw token
  ├── store sha256(token) only
  └── return the raw token, used once to build a link, then gone

consumeToken(rawToken, purpose)
  └── UPDATE ... SET consumed_at = now()
       WHERE token_hash = $1 AND purpose = $2
         AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now()
     RETURNING user_id
```

| Property | How |
| --- | --- |
| Stored hashed only | SHA-256, 64 hex. Verified in tests by recomputing the digest of the emailed token and by asserting the raw value matches no row. |
| Raw token's lifetime | One function call. Never persisted, never logged, never audited, never returned by a read path. |
| Verification TTL | 24 hours |
| Reset TTL | 1 hour |
| One-time use | The UPDATE *is* the check. Two simultaneous clicks cannot both win. |
| Purpose enforced | Part of every lookup — a verification token presented at the reset endpoint simply does not match. |
| Re-issue invalidates | Both purposes. A second reset request kills the first link. |

**Why SHA-256 and not scrypt.** Passwords are low-entropy and need a slow hash.
These tokens are 256 bits of CSPRNG output — there is no dictionary to try, and
a fast hash lets the lookup use the unique index instead of scanning.

---

## 3. Anti-enumeration

The reset request has **one outcome**: `redirect('/forgot-password/sent')`. Real
address, unknown address, suspended account, throttled request, and even a
malformed address all take it. Not similar responses — the same response, same
status, same location.

**Timing is part of it.** Everything that could differ happens inside Next's
`after()`, which runs once the response is already on its way. The lookup, the
token write and the provider call are all after the redirect, so "no account"
and "account found, token issued, mail sent" cannot be told apart by a stopwatch.
This is why `after()` was used rather than a fire-and-forget promise: it is the
supported way to keep work alive past the response without the platform killing
it mid-flight.

The confirmation page says *"If an account exists for that address, we've sent a
link"*. The vaguer "we've sent you an email" would be a lie in the cases where
nothing was sent. Stating the condition tells the truth and still leaks nothing.

**Where specificity is safe, it is used.** The signed-in resend page names the
address and says exactly how many seconds to wait, because the visitor already
proved they hold that account. Being vague with someone about their own account
is unhelpful, not secure.

---

## 4. Throttling

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
production hardening in §10 rather than shipped ahead of evidence.

---

## 5. Session handling

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

Order matters: consume the token, write the password, revoke, audit, redirect.
Consuming first means a later failure leaves the link spent rather than
reusable. Revoking after the write means there is no window where the old
password still works against a live session.

Verification does not touch sessions — confirming an address is not an
authentication event.

---

## 6. Account state

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

## 7. Provider abstraction

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

## 8. Accessibility and no-JS

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

## 9. Security review

| Concern | Handling |
| --- | --- |
| **Host-header link forgery** | Links are built from `NEXT_PUBLIC_APP_URL`. `Host` and `X-Forwarded-Host` are attacker-controlled; a reset link assembled from them would deliver a live credential to a domain of the attacker's choosing, inside a genuine email from us. The request's opinion of its own hostname is never in scope. |
| Token disclosure at rest | SHA-256 only. A database dump yields nothing replayable. |
| Token in logs | Asserted: no audit summary contains a token, password, URL, or `@`. |
| Token replay | Atomic single-use, plus supersession on re-issue. |
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

## 10. Test results

```
npm run test:recovery   86 passed, 0 failed   (dev server, EMAIL_PROVIDER=capture)
npm run test:email      12 passed, 0 failed   (transport config, process-isolated)
npm run test:e2e        90 passed, 0 failed   (regression, production build)
npm run test:bag        63 passed, 0 failed   (regression, production build)
npm run test:auth       28 passed, 0 failed   (regression)
lint                    0 errors, 1 pre-existing warning
typecheck               clean
build                   clean
```

Every required case from the brief is covered, including: token stored hashed;
raw token never persisted; purpose enforced; expired rejected; consumed rejected
on replay; resend supersedes the previous link; both throttles; unknown email
produces an identical public response; no reset token created for an unknown
address; `email_verified_at` set exactly once; password changed; old password
dead; new password works; all sessions revoked; **reset does not authenticate**;
change preserves the current session and revokes the others; no raw token in any
audit row; production refuses missing configuration; console transport never
runs in production; no-JS forms work.

**Harness discipline.** Every row the suites create is captured by id at
creation and deleted by id. There are no shape-based deletes anywhere — no time
windows, no `WHERE event = …`. Pre-existing audit rows are snapshotted and
asserted to survive: `all 601 pre-existing audit rows survived`.

### Two bugs the suites caught

**The capture transport did not work.** It was an in-memory array, and a Server
Action and a Route Handler are separate bundles with separate module instances —
the action pushed into one array while the debug route read a different, always
empty one. Tokens were being issued correctly and the outbox looked broken. Now
a newline-delimited file, which is the boundary both sides genuinely share.

**The confirmation link was unreachable without a session** (§8).

---

## 11. Production rollout requirements

**Not started. Nothing below has been done.**

1. **Choose and verify a sending domain** — SPF and DKIM records, and a real
   monitored `EMAIL_REPLY_TO`. Deliverability for a licensed cannabis retailer
   depends on the domain being clean and the mail being unambiguously
   transactional.
2. **Create the Resend API key** and set, in Vercel **Production only**, marked
   Sensitive: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`,
   `EMAIL_REPLY_TO`. Preview must stay without them — it has no `DATABASE_URL`
   either and is fail-closed by construction.
3. **Confirm `NEXT_PUBLIC_APP_URL`** is the canonical public origin. Every link
   in every email is built from it.
4. **Apply migration 0007** before deploying the code, using the same gated
   sequence as 0005/0006: `verify-migration-target.mjs` → `GO` → `drizzle-kit
   migrate` → confirm. The code tolerates the enum values being absent only in
   the sense that nothing writes them yet; deploying code first would fail on
   the first audit insert.
5. **Smoke-test delivery** with Resend's `delivered@resend.dev` and
   `bounced@resend.dev` before pointing a real customer at it.
6. **Then** decide on IP-scoped rate limiting (§4) — Postgres bucket table
   preferred over a new vendor.

**Out of scope, unchanged:** checkout, orders, payments, 2FA, magic links,
OAuth, email-address change, marketing email, bounce/webhook processing.
