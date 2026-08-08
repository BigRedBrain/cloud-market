/**
 * Test-only environment defaults for the Phase 5 suites.
 *
 * IMPORTED FIRST, AND THE ORDERING IS LOAD-BEARING. `serverEnv()` parses
 * `process.env` once and caches the result, and `hashInviteCode` throws when the
 * pepper is absent — by design, so that a deployment which forgot to configure
 * one fails closed rather than issuing invites it cannot verify. That means the
 * values below have to be in place before any module that reads them is
 * evaluated, and ES module imports run in source order, so this module must
 * appear above the others in every suite that needs it.
 *
 * A separate file rather than assignments at the top of each suite, because
 * imports are hoisted: `process.env.X = ...` written above an `import` statement
 * in the same file still runs after that import has been evaluated.
 *
 * NONE OF THESE VALUES IS A SECRET, and none of them is used anywhere but the
 * test suites. They are fixed rather than random so that a failing run is
 * reproducible.
 */

import { assertUsableEnv } from './lib/env-file.mjs'

/**
 * FAIL CLOSED IF THE ENVIRONMENT ARRIVED CORRUPTED.
 *
 * Every Phase 5 suite runs under `tsx --env-file=.env.local`, and Node's
 * `--env-file` parser does not strip a UTF-8 byte order mark. A `.env.local`
 * saved with one leaves its FIRST variable set under a name containing an
 * invisible character: `process.env.DATABASE_URL` is `undefined` while a dump of
 * `process.env` shows what looks exactly like `DATABASE_URL`. A database suite
 * that then connects to whatever is left is worse than one that refuses.
 */
assertUsableEnv()

/** Only ever set if the developer has not configured a real one. */
process.env.INVITE_CODE_PEPPER ??=
  'phase-5-test-pepper-at-least-32-characters-long'

process.env.MOCK_PAYMENT_WEBHOOK_SECRET ??= 'phase-5-mock-webhook-secret'

/**
 * The crypto flag is left ALONE on purpose.
 *
 * The suite asserts that it defaults to disabled, and setting it here — in
 * either direction — would make that assertion test this file instead of the
 * gate. Each case sets and restores it explicitly.
 */

export {}
