/**
 * The only shape the rest of the application knows about.
 *
 * Nothing outside `lib/email/` imports a provider, and no provider type appears
 * in this file. Swapping Resend for Postmark is a new file next to `resend.ts`
 * plus one line in `index.ts` — the actions, the templates and the tests are
 * untouched, because none of them can tell which transport they are talking to.
 */

export type EmailMessage = {
  to: string
  subject: string
  html: string
  /**
   * Required, not optional. A transactional email without a text part is
   * treated as more spam-like by most filters, and it is the only version a
   * screen reader in a plain-text client will ever see.
   */
  text: string
}

export type EmailResult =
  | { ok: true; id: string }
  /**
   * Delivery failures are RETURNED, never thrown. A password reset that fails
   * to send must not surface as a 500 — the caller decides what the customer
   * sees, and the caller is the only place that knows whether saying "we could
   * not send that" would leak account existence.
   */
  | { ok: false; error: string }

export interface EmailTransport {
  readonly name: 'resend' | 'console' | 'capture'
  send(message: EmailMessage): Promise<EmailResult>
}

/** Rendered by a template. Both parts always travel together. */
export type RenderedEmail = { subject: string; html: string; text: string }
