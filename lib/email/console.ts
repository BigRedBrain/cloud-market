import 'server-only'

import type { EmailMessage, EmailResult, EmailTransport } from './types'

/**
 * Development transport. Prints the message and — crucially — the link.
 *
 * The link is the whole local workflow: there is no inbox to check, so the
 * terminal is the inbox. Printing the full URL is safe here and only here,
 * because this transport is unreachable in production (see index.ts).
 */
export const consoleTransport: EmailTransport = {
  name: 'console',
  async send(message: EmailMessage): Promise<EmailResult> {
    const links = [...message.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])
    console.log('\n──────────────── EMAIL (console transport) ────────────────')
    console.log(`to:      ${message.to}`)
    console.log(`subject: ${message.subject}`)
    for (const link of links) console.log(`link:    ${link}`)
    console.log('───────────────────────────────────────────────────────────\n')
    return { ok: true, id: `console-${Date.now()}` }
  },
}
