# Phase 3.5 — Email Verification, Password Recovery & Account Security

**Architecture proposal. No implementation, no provider account, no credentials,
no email sent.** For review before any code is written.

---

## 0. What already exists

Phase 1 built most of the substrate. This phase should extend it, not lay a
parallel one beside it.

| Already in place | Where |
| --- | --- |
| `verification_tokens` — `user_id`, `token_hash` (64 hex), `purpose`, `expires_at`, `consumed_at`, unique index on the hash | `lib/db/schema/auth.ts:145` |
| `token_purpose` enum — `email_verification`, `password_reset` | `lib/db/schema/auth.ts:50` |
| `user_status` — `pending_verification`, `active`, `suspended` | `lib/db/schema/auth.ts:43` |
| `users.email_verified_at` (nullable) | `lib/db/schema/auth.ts:66` |
| Audit events `PASSWORD_CHANGED`, `PASSWORD_RESET` | `lib/db/schema/audit.ts` |
| Session revocation, single and bulk | `lib/auth/session.ts:209,222` |
| scrypt hashing, SHA-256 token hashing, HMAC-SHA256 audit IP/UA | `lib/auth/*` |
| `/account/verify-email` placeholder page | `app/account/verify-email/page.tsx` |

**The gap is delivery, and the plumbing around it.** No email provider, no
dependency, no send/consume flow, no throttling, and sign-up currently writes
`status: 'active'` (`lib/auth/actions.ts:108`) rather than
`pending_verification` — a deliberate stopgap recorded in the code.

---

## 1. Email provider

**Proposal: Resend.**

| Option | Why / why not |
| --- | --- |
| **Resend** ✅ | React Email templates as first-class, one dependency, generous free tier (3k/mo, 100/day), Vercel-native, simple domain + DKIM setup. The template story matters: these emails are brand surfaces. |
| Postmark | Best-in-class deliverability for transactional mail and excellent bounce tooling; heavier setup, no free tier beyond a trial. **The one to switch to if deliverability ever becomes a problem.** |
| AWS SES | Cheapest at volume, but sandbox removal is a support ticket, and IAM + bounce/complaint SNS wiring is a lot of surface for two email types. |
| Nodemailer + SMTP | No vendor lock, but we would own deliverability, retries, and reputation. Wrong trade for a retailer with no mail expertise. |

**Provider is isolated behind an interface** so this is reversible:

```ts
// lib/email/types.ts
export type EmailMessage = { to: string; subject: string; html: string; text: string }
export interface EmailTransport {
  send(message: EmailMessage): Promise<{ id: string } | { error: string }>
}
```

`lib/email/resend.ts` implements it; `lib/email/console.ts` and
`lib/email/capture.ts` also implement it (§13). Nothing outside `lib/email/`
imports the provider SDK. Swapping to Postmark is one file.

**Cannabis-specific caveat worth surfacing now:** some ESPs restrict cannabis-
related senders in their acceptable-use policies, and enforcement is usually
aimed at *marketing* mail rather than transactional. These two emails are
strictly transactional — account security, no promotion, no product imagery, no
pricing. That distinction should be stated when the sending domain is set up,
and it is a reason to keep Phase 2.5's campaign engine well away from this
transport if marketing email ever ships.

---

## 2. Token model

**Reuse `verification_tokens` unchanged.** It was designed for exactly this and
already has the properties that matter.

```
token (sent)   = randomBytes(32).toString('base64url')   // 256 bits, opaque
token (stored) = sha256(token)                            // 64 hex chars
```

Same construction as guest bag tokens and session tokens, for the same three
reasons: nothing enumerable is ever exposed; a database disclosure yields no
usable tokens; and a forged token is a lookup miss rather than a path to
someone else's account.

**One shared implementation** in `lib/auth/tokens.ts` — `issueToken(userId,
purpose)` and `consumeToken(rawToken, purpose)` — because the two flows must not
drift in their security properties. `purpose` is matched in the lookup, so a
verification token cannot be replayed at the reset endpoint.

### Expiration

| Purpose | TTL | Reasoning |
| --- | --- | --- |
| `email_verification` | **24 hours** | People check mail on their own schedule. The risk carried by a stale verification link is low — worst case it confirms an address the account already claimed. |
| `password_reset` | **1 hour** | A reset link *is* an authentication credential. It sits in an inbox that may be shared, synced, forwarded, or on a lost phone. One hour is the common floor, and short enough that a stale link is rarely still live. |

### One-time use

`consumed_at` is set inside the same statement that validates the token:

```sql
UPDATE verification_tokens
   SET consumed_at = now()
 WHERE token_hash = $1 AND purpose = $2
   AND consumed_at IS NULL AND expires_at > now()
RETURNING user_id
```

Check and write are one atomic statement — no read-then-write window in which a
double-clicked link consumes twice. No row returned means invalid, expired, or
already used, and the caller cannot tell which. That is the same shape as the
cart's `least()` upsert and the merge's claim update.

The row is **kept**, not deleted, so a replayed link is distinguishable from an
expired one during investigation — which is precisely why `consumed_at` is a
timestamp rather than a boolean.

**Additional rule for password reset: issuing a new token invalidates the
account's outstanding ones.** Requesting a second reset must not leave the first
link live, or a stolen-then-superseded email still works.

---

## 3. Anti-enumeration

The governing rule, already established in `signInAction`: **an unauthenticated
caller must never learn whether an address has an account.**

| Surface | Behaviour |
| --- | --- |
| "Forgot password" submit | Always the same confirmation page and the same message, whether or not the address exists. No status-code, redirect, or wording difference. |
| Resend verification | Only available to a *signed-in* unverified user, so enumeration does not arise. |
| Sign-up with an existing address | Unchanged from today — this one genuinely cannot be hidden without breaking sign-up, and it is already rate-limited by the account lockout model. |
| Reset link for a nonexistent/suspended account | Page renders identically; no email is sent. |

**Timing must match too.** `signInAction` already calls
`equalizeTimingForMissingUser()`; the reset request path needs the same
treatment, because "no account" returns in 20ms while "account, hash a token,
queue an email" takes 200ms, and that difference is measurable. Concretely:
perform the work asynchronously after responding, or spend comparable time on
the miss path. **I recommend responding immediately and doing the send after the
response**, which is both constant-time and faster for everyone.

---

## 4. Session handling after password reset

**All sessions are revoked on reset. No exceptions, including the current one.**

A password reset is the remedy for "someone else may have my account". Leaving
their sessions alive defeats the entire exercise — the attacker keeps a valid
cookie while the owner congratulates themselves on a new password.

```
consume token → update password_hash → revoke ALL sessions for the user
              → create ONE fresh session (auto sign-in)  ← decision below
              → audit PASSWORD_RESET
```

**Open decision — auto sign-in after reset.** Signing them in is friendlier and
is what most storefronts do; requiring a fresh sign-in proves knowledge of the
new password and is marginally stricter. **I recommend auto sign-in**, because
the user just proved control of the email inbox *and* set the password, and
bouncing them to a login form after that is friction without a real security
gain. Flag if you disagree — it is a one-line difference.

**Password *change* (signed in, knows the old password) behaves differently:**
revoke all *other* sessions, keep the current one. That is already what
`revokeOtherSessions` does, and Phase 1 wired it.

**Verification does not touch sessions.** Confirming an address is not an
authentication event.

---

## 5. Account-state model

Today sign-up writes `status: 'active'` with `email_verified_at` null. The
proposal keeps that, and **does not** move new accounts to
`pending_verification`.

Reasoning: `status` answers "may this account be used at all" — `suspended` is
its meaningful negative. Verification answers a narrower question, and
`email_verified_at` already answers it precisely. Encoding the same fact twice
invites them to disagree, and `requireVerifiedUser` already gates on the
timestamp.

```
status = active,  email_verified_at = null  → browse, build a bag, no ordering
status = active,  email_verified_at = set   → full customer
status = suspended                          → nothing, regardless of verification
```

So `pending_verification` stays in the enum, unused, reserved for a future flow
that genuinely blocks sign-in until confirmation. **If you would rather it be
used now, that is a deliberate product decision** — it means an unverified
customer cannot build a bag, and given Phase 3 just made guest bags work well,
I would not.

Ordering stays gated on `email_verified_at` at the Phase 4 checkout boundary —
a licensed retailer should not dispatch age-restricted product to an address it
has never confirmed reaches a person.

---

## 6. Audit events

Five additions to the `audit_event` enum (migration 0007, additive, one-way like
0006):

```
EMAIL_VERIFICATION_SENT     — token issued and handed to the transport
EMAIL_VERIFIED              — token consumed, email_verified_at set
PASSWORD_RESET_REQUESTED    — request accepted (logged even when no account exists,
                              with user_id null — the attempt is the signal)
EMAIL_SEND_FAILED           — transport returned an error; the one operational
                              event here, and the one that will matter at 3am
PASSWORD_RESET_TOKEN_REUSED — a consumed or expired reset link was presented;
                              low-severity on its own, meaningful in a cluster
```

`PASSWORD_RESET` and `PASSWORD_CHANGED` already exist and are reused as-is.

**No token, raw or hashed, is ever written to the audit log.** Existing
convention holds: IP and user-agent are HMAC-SHA256 keyed with `AUTH_SECRET`,
never plain.

---

## 7. Resend throttling, rate limiting, abuse

Three distinct limits, all enforced server-side in the Server Action:

| Limit | Value | Scope | Enforcement |
| --- | --- | --- | --- |
| Resend verification | 1 per **60s**, max **5 per 24h** | per user | `count/max(created_at)` over `verification_tokens` |
| Password reset request | 1 per **60s**, max **5 per 24h** | per email | same, plus the address must exist |
| Reset attempts by IP | **20 per hour** | per HMAC'd IP | requires a store — see below |

The first two need **no new table**: `verification_tokens` already records
`created_at` and `user_id`, so the throttle is a query over rows this system
already writes. That is the cheapest correct answer and I would ship exactly it.

**The per-IP limit is the honest problem.** There is no shared rate-limit store
today, and a Vercel serverless deployment has no usable in-process memory across
invocations. Options:

1. **Postgres table** (`rate_limit_buckets`: key, window_start, count). No new
   infrastructure, one indexed upsert per request, easy to reason about. Adds
   write load to the primary database.
2. **Vercel KV / Upstash Redis.** The natural fit, purpose-built, but a new
   vendor, new credentials, and new failure modes.
3. **Defer it.** Per-account throttling already bounds the damage: an attacker
   cannot send more than 5 emails to any one address per day regardless of how
   many IPs they use. The uncapped harm is *aggregate* volume against many
   addresses — which is a provider-quota problem, not an account-security one.

**I recommend (3) for this phase, with (1) as the follow-up if abuse appears.**
Shipping a Redis dependency to rate-limit an endpoint that is already bounded
per-account is complexity ahead of evidence. This should be an explicit,
recorded decision rather than an omission — flag if you want (1) now.

---

## 8. Email templates

Two emails. Both **10% brand intensity** (DESIGN.md §9) — this is the "task
first" end of the scale. A password reset that arrives dressed like a
promotional blast is a phishing lesson in the making, and inbox providers
scrutinise heavy marketing markup on transactional mail.

| | Verify your email | Reset your password |
| --- | --- | --- |
| Subject | `Confirm your email for Cloud Market` | `Reset your Cloud Market password` |
| Body | One sentence, one button, the raw URL beneath it | Same, plus expiry stated in words |
| Expiry text | "This link works for 24 hours." | "This link works for 1 hour." |
| Safety line | — | "If you didn't ask for this, you can ignore this email. Your password won't change." |

**Constraints:**

- **Table-based HTML with inline styles**, plus a real `text/plain` alternative.
  Modern CSS is unreliable across mail clients, and a text part materially helps
  deliverability.
- **No images, no web fonts, no tracking pixel.** No remote assets at all —
  logo included, rendered as styled type. Nothing to block, nothing to leak.
- **The raw URL is always visible** as text under the button. Buttons that hide
  their destination are exactly the pattern users are told to distrust.
- **No promotional content, no product imagery, no pricing.** Keeps these
  unambiguously transactional (§1).
- Sender: `Cloud Market <no-reply@[domain]>`, with a real `Reply-To` reaching
  the retailer.

React Email components (Resend's library) generate both parts from one source.
If we later leave Resend, the templates are portable HTML.

---

## 9. Accessibility and no-JS

Same standard the rest of the app is held to — Phase 3 shipped a fully
functional no-JS path and this must match.

- **Every flow is a Server Action driven by a plain `<form>`.** Request a reset,
  resend a verification, set a new password: all work with JavaScript disabled.
- Verification links are `GET` to a Server Component page that performs the
  consume — nothing to click twice, no client JS.
- Errors use `role="status"` beside the control that caused them.
- Password fields: `autocomplete="new-password"`, visible strength/length
  requirements stated **before** submission, never colour alone.
- Success and failure are announced as text, not conveyed by icon or colour.
- Email HTML uses semantic headings and meaningful link text ("Confirm your
  email", never "click here").

**One genuine tension:** the anti-enumeration rule means the reset form gives
identical feedback whether or not the address exists — which is, from a pure
usability standpoint, a worse experience for someone who simply mistyped their
address. The copy should therefore be explicit rather than vague: *"If an
account exists for that address, we've sent a reset link. Check your spam
folder."* That sentence tells the truth, sets the expectation, and leaks
nothing.

---

## 10. Environment and secrets

```
RESEND_API_KEY        server-only, required in production, optional elsewhere
EMAIL_FROM            e.g. "Cloud Market <no-reply@example.com>"
EMAIL_REPLY_TO        a real monitored address
EMAIL_TRANSPORT       'resend' | 'console' | 'capture'   (default by NODE_ENV)
```

Added to `serverSchema` in `lib/env.ts`, following the existing pattern.
`NEXT_PUBLIC_APP_URL` is already validated and is what link generation uses —
links must be built from it, never from a request header, since `Host` is
attacker-controlled and would turn a reset link into a redirect to their domain.

**Validation rule:** `RESEND_API_KEY` is required **only** when
`EMAIL_TRANSPORT === 'resend'`, so development and CI never need a real key. In
production, boot must fail loudly if the transport is `resend` and the key is
missing — a storefront that silently stops sending reset emails is worse than
one that refuses to start.

**No credentials are created in this phase.** Domain verification and DKIM/SPF
setup happen when you decide to proceed, and `RESEND_API_KEY` goes into Vercel
**Production only**, marked Sensitive, matching how `DATABASE_URL` is held.
Preview must stay without it — fail-closed, as verified in Phase 3.

---

## 11. Development and testing strategy

**No real email is sent in development or in tests. Ever.**

| Transport | When | Behaviour |
| --- | --- | --- |
| `console` | local default | Prints subject, recipient and the **full link** to the terminal. The link is clickable — that is the entire local workflow. |
| `capture` | automated tests | Appends to an in-process array; the E2E suite asserts on it and extracts tokens. No network. |
| `resend` | production only | Real delivery. |

The E2E suite drives the full loop without a provider: request → capture → parse
the token from the captured link → follow it → assert consumption, expiry, reuse
rejection, and session revocation.

For a manual end-to-end check against a real provider before launch, Resend's
test addresses (`delivered@resend.dev`, `bounced@resend.dev`) exercise delivery
and bounce handling without mailing a person. That step is **explicitly out of
scope for this phase.**

---

## 12. Test plan

Extending `scripts/verify-auth-e2e.mjs` (89 assertions today), same harness
conventions — real HTTP, per-device cookie jars, hidden `$ACTION` fields, no-JS
posture.

**Verification (~14 assertions):** unverified user sees the prompt; resend issues
a token and an email is captured; link sets `email_verified_at`; second click
rejected (`consumed_at` already set); expired token rejected; a token of the
wrong `purpose` rejected at this endpoint; verified user is redirected away;
`EMAIL_VERIFICATION_SENT` and `EMAIL_VERIFIED` audited; resend inside 60s
throttled; 6th resend in 24h refused.

**Password reset (~18):** request for an existing address sends; request for a
nonexistent address sends nothing **but returns an identical response, status
and body**; response times comparable (same ratio assertion as the existing
timing test); link sets a new password; old password no longer works; new one
does; **every pre-existing session is dead**; a fresh session exists; token
rejected on reuse; expired token rejected; issuing a second token invalidates
the first; a verification token is rejected at the reset endpoint;
`PASSWORD_RESET_REQUESTED` and `PASSWORD_RESET` audited;
`PASSWORD_RESET_TOKEN_REUSED` audited on replay.

**Security and abuse (~8):** tokens never appear in any audit row; stored hash is
never equal to the sent token; a forged token is a clean miss, not an error;
reset link built from `NEXT_PUBLIC_APP_URL` and not from a spoofed `Host`
header; throttles enforced server-side even when the form is bypassed; suspended
account gets no reset email; transport failure records `EMAIL_SEND_FAILED` and
surfaces a retry-able message rather than a 500.

**Regression:** the existing 89 must stay green, plus `test:bag` (63) and
`test:auth` (28).

**Harness discipline, carried forward from the Phase 3 incident:** any row this
suite creates — tokens, users, audit rows — is captured **by id at creation
time** and removed by id. No shape-matching deletes, and pre-existing rows are
snapshotted and asserted to survive. That rule now applies to every harness in
this repo, not just the production one.

---

## 13. Proposed file layout

```
lib/email/
  types.ts        EmailTransport, EmailMessage
  index.ts        transport selection from EMAIL_TRANSPORT
  resend.ts       provider implementation
  console.ts      dev transport
  capture.ts      test transport
  templates/
    verify-email.tsx
    reset-password.tsx
lib/auth/
  tokens.ts       issueToken / consumeToken — shared by both purposes
  email-actions.ts  'use server' — requestPasswordReset, resendVerification,
                    completePasswordReset
app/(auth)/
  forgot-password/page.tsx
  reset-password/[token]/page.tsx
app/account/
  verify-email/page.tsx        (replaces today's placeholder)
  verify-email/[token]/page.tsx
```

Migration **0007**: five new `audit_event` values. Additive; the enum values are
one-way (same caveat as 0006 — Postgres cannot drop an enum value).

---

## 14. Decisions I need from you

1. **Provider: Resend?** (Postmark if deliverability is the priority over
   template ergonomics.)
2. **Auto sign-in after password reset?** I recommend yes.
3. **Per-IP rate limiting now, or defer with per-account throttles only?** I
   recommend defer, and record it.
4. **Leave new accounts `active`+unverified, or switch to
   `pending_verification`?** I recommend leaving as-is, so unverified customers
   can still build a bag.
5. **Sending domain** — needed before any provider setup, not before I write
   code. Nothing here is blocked on it.

## 15. Explicitly out of scope

Two-factor authentication, magic-link / passwordless sign-in, OAuth providers,
email change flow (which needs confirmation at *both* addresses and deserves its
own design), marketing email and preference management, bounce and complaint
webhook handling, and anything touching checkout, orders, payments, delivery,
taxes, discounts or inventory reservation.
