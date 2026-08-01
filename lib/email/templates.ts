import type { RenderedEmail } from './types'

/**
 * Transactional email templates. Two of them, and no more.
 *
 * BRAND INTENSITY: 10% (DESIGN.md §9) — the "task first" end of the scale.
 * These are security messages. A password reset dressed like a promotional
 * blast teaches customers that promotional-looking mail asking them to click a
 * link is normal, which is precisely the habit phishing relies on.
 *
 * HARD CONSTRAINTS, each with a reason:
 *
 *  - **No remote images, no logo file, no tracking pixel.** Nothing is fetched
 *    when the email is opened, so there is nothing to block, nothing to leak a
 *    read receipt, and no broken-image box when the client blocks assets by
 *    default. The wordmark is set in type.
 *  - **Tables and inline styles.** Not nostalgia — Outlook's rendering engine
 *    still ignores most modern layout CSS, and a reset email that arrives
 *    unreadable is a support call at best.
 *  - **The raw URL is always printed under the button.** A button whose
 *    destination is hidden is the exact pattern users are told to distrust, and
 *    a link that will not open needs a copyable fallback.
 *  - **No marketing content, no product imagery, no pricing.** Keeps these
 *    unambiguously transactional, which matters both for filtering and for the
 *    provider acceptable-use question noted in ARCHITECTURE-3.5.md §1.
 */

const INK = '#141416'
const PAPER = '#ffffff'
const MUTED = '#5b5b63'
const RULE = '#e4e4e8'
const ACTION = '#141416'

/**
 * Escapes text interpolated into the HTML part.
 *
 * Every value that reaches these templates is server-controlled today, but an
 * email body is still HTML being assembled by string concatenation, and the
 * moment someone passes a display name through here that stops being true.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function layout({
  heading,
  bodyHtml,
  actionLabel,
  url,
  footerHtml,
}: {
  heading: string
  bodyHtml: string
  actionLabel: string
  url: string
  footerHtml: string
}): string {
  const safeUrl = escapeHtml(url)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

<tr><td style="padding-bottom:24px;border-bottom:1px solid ${RULE};">
<span style="font-size:15px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${INK};">Cloud&nbsp;Market</span>
</td></tr>

<tr><td style="padding:28px 0 0;">
<h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>

<tr><td style="padding:24px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="background:${ACTION};border-radius:6px;">
<a href="${safeUrl}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:${PAPER};text-decoration:none;">${escapeHtml(actionLabel)}</a>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:0 0 24px;">
<p style="margin:0 0 6px;font-size:13px;color:${MUTED};">Or copy this link into your browser:</p>
<p style="margin:0;font-size:13px;word-break:break-all;"><a href="${safeUrl}" style="color:${INK};">${safeUrl}</a></p>
</td></tr>

<tr><td style="padding-top:20px;border-top:1px solid ${RULE};">
${footerHtml}
<p style="margin:14px 0 0;font-size:12px;color:${MUTED};">Cloud Market · Michigan licensed cannabis retailer</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

export function verificationEmail(url: string): RenderedEmail {
  return {
    subject: 'Confirm your email for Cloud Market',
    html: layout({
      heading: 'Confirm your email address',
      bodyHtml: `<p style="margin:0;font-size:15px;line-height:1.6;color:${INK};">Confirm this address to finish setting up your Cloud Market account. You'll need a confirmed email before your first order.</p>`,
      actionLabel: 'Confirm your email',
      url,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">This link works for 24 hours. If you did not create this account, you can ignore this email — nothing will happen.</p>`,
    }),
    text: [
      'Confirm your email address',
      '',
      "Confirm this address to finish setting up your Cloud Market account.",
      "You'll need a confirmed email before your first order.",
      '',
      'Confirm your email:',
      url,
      '',
      'This link works for 24 hours.',
      'If you did not create this account, you can ignore this email — nothing will happen.',
      '',
      'Cloud Market · Michigan licensed cannabis retailer',
    ].join('\n'),
  }
}

export function passwordResetEmail(url: string): RenderedEmail {
  return {
    subject: 'Reset your Cloud Market password',
    html: layout({
      heading: 'Reset your password',
      bodyHtml: `<p style="margin:0;font-size:15px;line-height:1.6;color:${INK};">Use the button below to choose a new password for your Cloud Market account. You'll be asked to sign in again afterwards.</p>`,
      actionLabel: 'Reset your password',
      url,
      footerHtml: `<p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};"><strong style="color:${INK};">This link works for 1 hour.</strong> If you did not ask to reset your password, you can ignore this email — your password will not change. If you keep receiving these, someone may be trying to access your account, and you should change your password.</p>`,
    }),
    text: [
      'Reset your password',
      '',
      'Use the link below to choose a new password for your Cloud Market account.',
      "You'll be asked to sign in again afterwards.",
      '',
      'Reset your password:',
      url,
      '',
      'This link works for 1 hour.',
      'If you did not ask to reset your password, you can ignore this email — your',
      'password will not change. If you keep receiving these, someone may be trying',
      'to access your account, and you should change your password.',
      '',
      'Cloud Market · Michigan licensed cannabis retailer',
    ].join('\n'),
  }
}
