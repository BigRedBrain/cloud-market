/**
 * Invite code primitives — deterministic checks.
 *
 * Run: npm run test:invite
 *
 * HERMETIC BY CONSTRUCTION. No `.env.local`, no database, no network, no real
 * secret. Every value below is a throwaway fixture, and they are assigned with
 * `=` rather than `??=` on purpose: `??=` would defer to whatever the ambient
 * environment already held, so a developer with a real `INVITE_CODE_PEPPER`
 * exported in their shell would silently test against it. The point of a
 * fixture is that it is the same everywhere, including CI.
 *
 * These must be set BEFORE the dynamic imports at the bottom. `lib/env` parses
 * the client schema at module load and caches the server schema on first
 * access, so anything assigned after the first import would arrive too late.
 *
 * The database URL never opens a connection: `lib/invites/*` imports only
 * `serverEnv`, never `lib/db`. It exists solely to satisfy schema validation.
 *
 * This file exists because `inviteCodePrefix()` shipped wrong once already: it
 * sliced the first group off the normalised string without removing the `CM`
 * that normalisation had just run together with it, so a code beginning
 * `CM-4F2X` produced the prefix `CM-CM4F`. That is a bug you cannot see by
 * reading the function — only by running it.
 */

process.env.INVITE_CODE_PEPPER = 'verify-invite-code-fixture-pepper-0000'
process.env.AUTH_SECRET = 'verify-invite-code-fixture-auth-secret-0000'
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture'
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const pass = actual === expected
  if (!pass) failures += 1
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  )
}

function assert(name: string, condition: boolean, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `\n        ${detail}`}`)
}

async function main() {
  const {
    INVITE_ALPHABET,
    INVITE_GROUP_COUNT,
    INVITE_GROUP_SIZE,
    INVITE_PREFIX,
    inviteCodePrefix,
  } = await import('../lib/invites/hash')
  const { generateInviteCode, maskInviteCode } = await import(
    '../lib/invites/generate'
  )

  console.log('\n-- inviteCodePrefix ---------------------------------------')

  // The regression this file exists for.
  check(
    'full generated code yields the first group, not the prefix',
    inviteCodePrefix('CM-4F2X-9TQP-ABCD-EFGH-JKNP'),
    'CM-4F2X',
  )

  check(
    'lower case and missing dashes normalise the same way',
    inviteCodePrefix('cm4f2x9tqpabcdefghjknp'),
    'CM-4F2X',
  )

  check(
    'idempotent — feeding a prefix back in returns it unchanged',
    inviteCodePrefix('CM-4F2X'),
    'CM-4F2X',
  )

  check(
    'a first group that itself starts with CM survives',
    inviteCodePrefix('CM-CMAB-9TQP-ABCD-EFGH-JKNP'),
    'CM-CMAB',
  )

  check(
    'ambiguous characters fold to the alphabet (O -> 0, I -> 1)',
    inviteCodePrefix('CM-O12I-9TQP-ABCD-EFGH-JKNP'),
    'CM-0121',
  )

  check('input too short returns empty', inviteCodePrefix('CM-4'), '')
  check('empty input returns empty', inviteCodePrefix(''), '')

  console.log('\n-- generateInviteCode -------------------------------------')

  const bodyLength = INVITE_GROUP_SIZE * INVITE_GROUP_COUNT
  const alphabet = new Set(INVITE_ALPHABET.split(''))

  let shapeOk = true
  let prefixOk = true
  let alphabetOk = true
  let digestOk = true
  const seen = new Set<string>()

  for (let i = 0; i < 500; i += 1) {
    const { code, codeHash, codePrefix } = generateInviteCode()
    const groups = code.split('-')

    // CM plus five groups.
    if (groups[0] !== INVITE_PREFIX || groups.length !== INVITE_GROUP_COUNT + 1) {
      shapeOk = false
    }
    if (groups.slice(1).some((g) => g.length !== INVITE_GROUP_SIZE)) {
      shapeOk = false
    }

    // The property the bug violated: codePrefix must equal the literal prefix
    // joined to the FIRST GENERATED GROUP of its own code.
    if (codePrefix !== `${INVITE_PREFIX}-${groups[1]}`) prefixOk = false
    if (inviteCodePrefix(code) !== codePrefix) prefixOk = false

    if (groups.slice(1).join('').split('').some((c) => !alphabet.has(c))) {
      alphabetOk = false
    }

    if (!/^[0-9a-f]{64}$/.test(codeHash)) digestOk = false

    seen.add(code)
  }

  assert('500 codes all have the CM + 5x4 shape', shapeOk)
  assert(
    'codePrefix always matches prefix + first group of its own code',
    prefixOk,
  )
  assert('every character comes from INVITE_ALPHABET', alphabetOk)
  assert('codeHash is 64 hex characters', digestOk)
  assert(
    'no collisions across 500 draws',
    seen.size === 500,
    `${500 - seen.size} duplicate(s)`,
  )

  console.log('\n-- entropy / format --------------------------------------')

  const bits = bodyLength * Math.log2(INVITE_ALPHABET.length)
  assert(
    `body carries ${bits} bits (>= 100)`,
    bits >= 100,
    `alphabet ${INVITE_ALPHABET.length}, body ${bodyLength} chars`,
  )
  check('alphabet excludes I, L, O, U',
    ['I', 'L', 'O', 'U'].some((c) => INVITE_ALPHABET.includes(c)),
    false,
  )

  const sample = generateInviteCode()
  check(
    'maskInviteCode reveals only the stored prefix',
    maskInviteCode(sample.codePrefix),
    `${sample.codePrefix}-••••-••••-••••-••••`,
  )
  assert(
    'masked form leaks no character of the body past the first group',
    !maskInviteCode(sample.codePrefix).includes(sample.code.split('-')[2]),
  )

  console.log(
    `\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s)\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
