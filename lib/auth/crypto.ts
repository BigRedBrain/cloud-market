import 'server-only'

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'

/**
 * Password and token primitives.
 *
 * Uses Node's built-in scrypt rather than adding bcrypt or argon2. scrypt is
 * memory-hard, is in the standard library (no native build step, nothing to go
 * stale in the supply chain), and at these parameters costs an attacker ~32 MB
 * per guess — which is what actually defeats GPU cracking. bcrypt is not
 * memory-hard; argon2id is marginally stronger but is a native dependency, and
 * that trade is not worth it here.
 */

/**
 * Promise wrapper written by hand rather than with `promisify`, which collapses
 * scrypt's overloads and drops the `options` parameter — silently making the
 * cost parameters unsettable.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

/**
 * cost 2^15, blockSize 8, parallelism 1 → ~33 MB and ~100 ms per hash on
 * commodity hardware. Node's default `maxmem` is 32 MB, which these parameters
 * exceed, so it is raised explicitly — without it scrypt throws at runtime.
 */
const SCRYPT_COST = 2 ** 15
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELISM = 1
const SCRYPT_KEY_LENGTH = 64
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const SALT_BYTES = 16
const SESSION_TOKEN_BYTES = 32

/**
 * Encoded as `scrypt$N$r$p$salt$hash` so the parameters travel with the hash.
 * When the cost is raised later, existing hashes still verify against their own
 * recorded parameters and can be re-hashed transparently on next sign-in.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAXMEM,
  })

  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt stored
 * value must read as "wrong password", never as a 500 that tells an attacker
 * something about the account.
 */
export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  if (!encoded) return false

  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw] = parts
  const cost = Number(costRaw)
  const blockSize = Number(blockRaw)
  const parallelism = Number(parallelRaw)

  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false
  }

  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(hashRaw, 'base64')
    actual = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltRaw, 'base64'),
      expected.length,
      { N: cost, r: blockSize, p: parallelism, maxmem: SCRYPT_MAXMEM },
    )
  } catch {
    return false
  }

  // timingSafeEqual throws on length mismatch, which would itself be a signal.
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Burns roughly one password-verification's worth of time.
 *
 * Called when sign-in is attempted against an address that has no account, so
 * that "no such user" and "wrong password" take comparable time. Without this,
 * response latency alone enumerates which email addresses are registered.
 */
export async function equalizeTimingForMissingUser(): Promise<void> {
  await verifyPassword(
    'timing-equalisation',
    'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
      Buffer.alloc(SCRYPT_KEY_LENGTH).toString('base64'),
  )
}

/**
 * Opaque session token — 256 bits from the CSPRNG, base64url so it is
 * cookie-safe without escaping. Never derived from user data, so it carries no
 * information and cannot be forged from anything an attacker might know.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

/**
 * SHA-256, hex, 64 chars — matches the `varchar(64)` columns.
 *
 * Session and verification tokens are stored hashed for the same reason
 * passwords are: a database disclosure must not hand over live sessions. A fast
 * hash is correct here (unlike for passwords) because the input already has 256
 * bits of entropy, so there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
