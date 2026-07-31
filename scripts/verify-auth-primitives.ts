/**
 * Verifies the security-critical pure functions in the auth layer.
 *
 *   npx tsx --conditions=react-server scripts/verify-auth-primitives.ts
 *
 * The `--conditions=react-server` flag matters: `lib/auth/crypto.ts` imports
 * `server-only`, which deliberately throws outside a React Server environment.
 * That condition resolves it to the empty module, exactly as the Next build
 * does.
 *
 * These are the functions where a mistake is a vulnerability rather than a bug,
 * so they get checked directly instead of only through the UI.
 */
import assert from 'node:assert/strict'

import {
  equalizeTimingForMissingUser,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../lib/auth/crypto'
import {
  ageInYears,
  safeRedirectPath,
  signInSchema,
  signUpSchema,
} from '../lib/auth/validation'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name}`)
    console.error(`        ${(error as Error).message.split('\n')[0]}`)
  }
}

async function main() {
  console.log('\n[1] password hashing')

  const hash = await hashPassword('correct horse battery staple')

  await check('hash is scrypt-encoded with its parameters', () => {
    const parts = hash.split('$')
    assert.equal(parts.length, 6)
    assert.equal(parts[0], 'scrypt')
    assert.equal(Number(parts[1]), 32768)
  })

  await check('same password hashes differently (salted)', async () => {
    const again = await hashPassword('correct horse battery staple')
    assert.notEqual(hash, again)
  })

  await check('correct password verifies', async () => {
    assert.equal(await verifyPassword('correct horse battery staple', hash), true)
  })

  await check('wrong password rejected', async () => {
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false)
  })

  await check('empty password rejected', async () => {
    assert.equal(await verifyPassword('', hash), false)
  })

  await check('null hash rejected (OAuth-only account)', async () => {
    assert.equal(await verifyPassword('anything', null), false)
  })

  await check('malformed hash returns false, does not throw', async () => {
    assert.equal(await verifyPassword('x', 'not-a-hash'), false)
    assert.equal(await verifyPassword('x', 'scrypt$abc$8$1$zz$zz'), false)
    assert.equal(await verifyPassword('x', '$$$$$'), false)
  })

  await check('unicode normalises (NFKC) so equivalent input matches', async () => {
    const composed = await hashPassword('café password 123')
    // Same string, decomposed form: e + combining acute.
    assert.equal(await verifyPassword('café password 123', composed), true)
  })

  await check('timing equalisation runs without throwing', async () => {
    await equalizeTimingForMissingUser()
  })

  console.log('\n[2] token generation')

  await check('session token is 256 bits, base64url', () => {
    const token = generateSessionToken()
    assert.match(token, /^[A-Za-z0-9_-]+$/)
    assert.equal(Buffer.from(token, 'base64url').length, 32)
  })

  await check('session tokens are unique across 1000 draws', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateSessionToken()))
    assert.equal(seen.size, 1000)
  })

  await check('token hash is deterministic 64-char hex', () => {
    const token = generateSessionToken()
    assert.equal(hashToken(token), hashToken(token))
    assert.match(hashToken(token), /^[0-9a-f]{64}$/)
  })

  await check('different tokens hash differently', () => {
    assert.notEqual(hashToken('a'), hashToken('b'))
  })

  console.log('\n[3] age gate (21+, Michigan)')

  await check('exact 21st birthday passes', () => {
    const now = new Date('2026-07-31T00:00:00Z')
    assert.equal(ageInYears(new Date('2005-07-31T00:00:00Z'), now), 21)
  })

  await check('day before 21st birthday fails', () => {
    const now = new Date('2026-07-30T00:00:00Z')
    assert.equal(ageInYears(new Date('2005-07-31T00:00:00Z'), now), 20)
  })

  await check('signUp rejects under-21', () => {
    const result = signUpSchema.safeParse({
      email: 'a@example.com',
      password: 'a-long-enough-password',
      name: 'Test',
      dateOfBirth: '2010-01-01',
    })
    assert.equal(result.success, false)
  })

  await check('signUp accepts 21+', () => {
    const result = signUpSchema.safeParse({
      email: 'A@Example.COM  ',
      password: 'a-long-enough-password',
      name: 'Test',
      dateOfBirth: '1990-01-01',
    })
    assert.equal(result.success, true)
    // Email must be normalised for the unique index to mean anything.
    assert.equal(result.data?.email, 'a@example.com')
  })

  await check('signUp rejects short password', () => {
    const result = signUpSchema.safeParse({
      email: 'a@example.com',
      password: 'short',
      name: 'Test',
      dateOfBirth: '1990-01-01',
    })
    assert.equal(result.success, false)
  })

  await check('signIn does NOT apply a length policy to existing passwords', () => {
    const result = signInSchema.safeParse({ email: 'a@example.com', password: 'x' })
    assert.equal(result.success, true)
  })

  console.log('\n[4] open-redirect protection')

  const blocked = [
    'https://evil.example.com',
    '//evil.example.com',
    'http://evil.example.com',
    '\\\\evil.example.com',
    '/\\evil.example.com',
    'javascript:alert(1)',
    'evil.example.com',
  ]

  for (const candidate of blocked) {
    await check(`blocks ${JSON.stringify(candidate)}`, () => {
      assert.equal(safeRedirectPath(candidate), '/account')
    })
  }

  await check('allows a same-origin path', () => {
    assert.equal(safeRedirectPath('/account/security'), '/account/security')
  })

  await check('falls back when absent', () => {
    assert.equal(safeRedirectPath(undefined), '/account')
  })

  console.log(
    `\nRESULT: ${passed} passed, ${failed} failed\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

void main()
