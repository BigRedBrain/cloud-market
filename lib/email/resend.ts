import 'server-only'

import type { EmailMessage, EmailResult, EmailTransport } from './types'

/**
 * Resend, over its REST API.
 *
 * NO SDK DEPENDENCY. The API is one authenticated POST with a JSON body, and
 * `fetch` is built in. Adding a package to construct that request would buy
 * nothing and would put a vendor's code — and its transitive dependencies — on
 * the path of every password reset. The abstraction in `types.ts` is what makes
 * the provider replaceable; the SDK would not have helped with that.
 *
 * Errors are RETURNED, never thrown. A transport failure must not become a 500
 * on a page where a 500 would itself leak information about which addresses
 * exist.
 */

const ENDPOINT = 'https://api.resend.com/emails'
const TIMEOUT_MS = 10_000

export function createResendTransport(config: {
  apiKey: string
  from: string
  replyTo?: string
}): EmailTransport {
  return {
    name: 'resend',
    async send(message: EmailMessage): Promise<EmailResult> {
      /**
       * Bounded. Without a timeout a hung provider connection would hold the
       * serverless invocation open until the platform killed it, and `after()`
       * work would be cut off mid-flight.
       */
      const abort = AbortSignal.timeout(TIMEOUT_MS)

      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          signal: abort,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(config.replyTo ? { reply_to: [config.replyTo] } : {}),
          }),
        })

        if (!response.ok) {
          /**
           * The provider's error body can echo the request, so only the status
           * and a short message are surfaced. The recipient address must not
           * end up in a log line that is less protected than the audit table.
           */
          const detail = await response.text().catch(() => '')
          return {
            ok: false,
            error: `resend responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          }
        }

        const body = (await response.json()) as { id?: string }
        return { ok: true, id: body.id ?? 'unknown' }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error'
        return { ok: false, error: `resend request failed: ${reason}` }
      }
    },
  }
}
