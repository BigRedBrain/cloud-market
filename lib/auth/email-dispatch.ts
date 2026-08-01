import 'server-only'

import { recordAuditEvent } from '@/lib/auth/audit'
import { discardToken, issueToken, type TokenPurpose } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/email'
import { passwordResetEmail, verificationEmail } from '@/lib/email/templates'
import { clientEnv } from '@/lib/env'

/**
 * Issuing a token and handing the message to the transport.
 *
 * DELIBERATELY NOT IN A `'use server'` MODULE. It takes a userId and an email
 * address, and an exported Server Action is a public network endpoint —
 * exposing this one would let any caller mail a verification or reset link for
 * an arbitrary account to an arbitrary address, which is a phishing primitive
 * wearing our sending domain. It lives here, behind `server-only`, and is
 * called by `signUpAction`, `resendVerificationAction` and
 * `requestPasswordResetAction`, each of which has already established who the
 * caller is.
 *
 * This is the same boundary `mergeGuestBagIntoUser` sits behind, for the same
 * reason.
 *
 * LINKS ARE BUILT FROM `NEXT_PUBLIC_APP_URL`, NEVER FROM A REQUEST HEADER.
 * `Host` and `X-Forwarded-Host` are attacker-controlled; a reset link assembled
 * from them delivers a live credential to a domain of the attacker's choosing,
 * inside a genuine email from us. The request's opinion of its own hostname is
 * never in scope here — this module has no access to it.
 */

const APP_URL = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')

const verifyUrl = (token: string) =>
  `${APP_URL}/verify-email/${encodeURIComponent(token)}`
const resetUrl = (token: string) =>
  `${APP_URL}/reset-password/${encodeURIComponent(token)}`

/**
 * Always called inside `after()`, so provider latency never shapes the response
 * a visitor sees.
 *
 * For password reset that is a security property rather than a performance one:
 * "no account" returning in 20ms while "account found, token issued, mail sent"
 * takes 400ms is a measurable enumeration oracle, and no amount of matched
 * wording hides it. For sign-up and resend it is simply the right shape — a
 * slow or unreachable provider must not delay account creation or make it fail.
 */
export async function issueAndSend(
  userId: string,
  email: string,
  purpose: TokenPurpose,
): Promise<void> {
  const { token } = await issueToken(userId, purpose)

  const rendered =
    purpose === 'email_verification'
      ? verificationEmail(verifyUrl(token))
      : passwordResetEmail(resetUrl(token))

  const result = await sendEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!result.ok) {
    /**
     * DELIVERY FAILED, SO THE TOKEN IS DISCARDED.
     *
     * Issuing it cost the customer one of their five daily sends and started a
     * 60-second cooldown. Leaving the row in place would mean a provider outage
     * locks people out of recovery for a day — the throttle punishing them for
     * our failure. Removing it returns both budgets immediately, so "try again"
     * works straight away.
     *
     * The link goes with it. If the message did somehow arrive despite the
     * error, its link is dead and the customer requests another; that is the
     * safe direction to be wrong in.
     *
     * No queue and no retry loop. This phase does not need one, and a queue
     * silently retrying a message we have already told the customer about would
     * make the state harder to reason about, not easier.
     */
    await discardToken(token, purpose)

    /**
     * The transport's message can name the recipient, so it is not stored. Only
     * the fact of failure and the purpose are recorded — enough to alert on,
     * nothing that turns the audit log into a mailing list.
     */
    await recordAuditEvent({
      event: 'EMAIL_SEND_FAILED',
      userId,
      entityType: 'email',
      summary: `${purpose} delivery failed; token discarded so the customer can retry`,
    })
  }
}
