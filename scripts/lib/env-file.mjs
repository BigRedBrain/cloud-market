/**
 * BOM-safe environment loading, and a guard against the failure it prevents.
 *
 * WHY THIS MODULE EXISTS
 *
 * A `.env.local` saved by Notepad, PowerShell's `Out-File`, or any Windows
 * editor defaulting to "UTF-8 with BOM" begins with the three bytes
 * `EF BB BF` (U+FEFF). Node's built-in `--env-file` parser does not strip it,
 * so the first line parses as a variable whose NAME begins with an invisible
 * character. `process.env.DATABASE_URL` is then `undefined` while `process.env`
 * genuinely contains a key that LOOKS like `DATABASE_URL` in any dump of it.
 *
 * Every script in this repository that runs under `tsx --env-file=.env.local`
 * is exposed to that, and the behaviour is measured rather than assumed:
 *
 *     node --env-file=bom.env -e "console.log(process.env.DATABASE_URL)"  // undefined
 *
 * The consequence for THIS project is specific and serious. `drizzle.config.ts`
 * prefers `DATABASE_URL_UNPOOLED ?? DATABASE_URL`. A BOM that swallows whichever
 * of those is written first does not produce an error — it produces a fallback,
 * silently, to a DIFFERENT DATABASE. A missing variable that fails loudly is an
 * inconvenience; a missing variable that fails quietly is how a migration lands
 * on the wrong branch.
 *
 * `dotenv` does tolerate the BOM (its line pattern begins with `\s*`, and
 * JavaScript's `\s` includes U+FEFF), which was also verified rather than
 * assumed. That is precisely why the two loaders disagree, and why "it works
 * under drizzle-kit but not under tsx" is a real state this repository can be
 * in — the most confusing possible symptom of a single invisible byte.
 *
 * SO THIS MODULE DOES TWO THINGS
 *
 *   1. `loadEnvFile()` — reads a file, strips any BOM, and parses the result.
 *      Used instead of `dotenv.config({ path })` so the behaviour does not
 *      depend on a dependency's internals staying the way they are today.
 *
 *   2. `environmentProblems()` / `assertUsableEnv()` — fail CLOSED if
 *      `process.env` already contains a mangled key, which is the only defence
 *      available against a variable Node imported before any of our code ran.
 *
 * NOTHING HERE EVER PRINTS A VALUE. Messages name keys and nothing else — the
 * whole point of the module is to be safe to run in the same shell as a
 * production credential.
 */
import { readFileSync } from 'node:fs'

/** The byte order mark, as a code point. */
export const BOM_CODE_POINT = 0xfeff

/**
 * Code points that must never appear in a variable NAME.
 *
 * Listed numerically rather than written into a regular expression, because
 * every one of them is INVISIBLE: a literal character class here would be a
 * line no reviewer could read and no diff could show honestly.
 */
const MANGLING_CODE_POINTS = new Set([
  // C0 controls and the space character.
  ...Array.from({ length: 0x21 }, (_, index) => index),
  0x7f, // delete
  0xa0, // non-breaking space - the one that arrives by copy-paste
  0x200b, // zero-width space
  BOM_CODE_POINT,
])

const isManglingCharacter = (character) =>
  MANGLING_CODE_POINTS.has(character.codePointAt(0) ?? -1)

/** Removes a leading BOM. Returns the input unchanged when there is none. */
export function stripBom(text) {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text
}

/**
 * Is this a key that will never be readable as the operator intended?
 *
 * A BOM is the case this module was written for, but the same class of bug
 * arrives with a non-breaking space pasted from a web page or a stray space
 * before the `=`. All of them share one property: the key looks correct in a
 * terminal and does not match the string the code asks for.
 */
export function isMangledKey(key) {
  return [...key].some(isManglingCharacter)
}

/**
 * Every mangled key in an environment, paired with the name it was meant to be.
 *
 * Returns `{ raw, intended }` rather than a boolean so a caller can say "your
 * file starts with a BOM, and DATABASE_URL is the variable it ate".
 */
export function mangledEnvKeys(env = process.env) {
  return Object.keys(env)
    .filter(isMangledKey)
    .map((raw) => ({
      raw,
      intended: [...raw].filter((character) => !isManglingCharacter(character)).join(''),
    }))
}

/**
 * Environment problems, as strings, for a caller assembling a NO-GO report.
 *
 * Named keys only. Never a value.
 */
export function environmentProblems(env = process.env) {
  return mangledEnvKeys(env).map(
    ({ intended }) =>
      `The environment contains a corrupted variable NAME: "${intended}" is set but ` +
      'unreadable by any code that asks for it. This is what a UTF-8 BOM does to the ' +
      "FIRST line of a .env file under Node's --env-file parser. Re-save the file as " +
      'UTF-8 WITHOUT a BOM (PowerShell: Set-Content -Encoding utf8NoBOM) and re-run.',
  )
}

/** The throwing form, for entry points with nowhere to collect a problem. */
export function assertUsableEnv(env = process.env) {
  const problems = environmentProblems(env)
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

/**
 * Parses `.env` text into a plain object.
 *
 * Deliberately small and deliberately ours: quoting, an `export ` prefix,
 * comments and blank lines, and nothing else. A `.env` file needing more than
 * this is a `.env` file that should have been a script.
 */
export function parseEnvText(text) {
  const parsed = {}

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = withoutExport.indexOf('=')
    if (separator <= 0) continue

    const key = withoutExport.slice(0, separator).trim()
    let value = withoutExport.slice(separator + 1).trim()

    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))

    if (quoted) {
      const quote = value[0]
      value = value.slice(1, -1)
      // Only double quotes interpret escapes, as in every other .env parser.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    } else {
      // An unquoted trailing comment is not part of the value.
      const comment = value.indexOf(' #')
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    parsed[key] = value
  }

  return parsed
}

/**
 * Loads a `.env` file into `env`, BOM and all handled.
 *
 * `override` defaults to false, matching dotenv and matching the assumption the
 * migration gate is built on: a variable EXPORTED IN THE SHELL always wins over
 * a file. A loader that overrode would mean an operator who carefully exported a
 * production string could still be silently redirected by `.env.local`.
 *
 * A missing file is not an error — callers ask for `.env.local` and `.env` in
 * turn, and most checkouts have only one.
 */
export function loadEnvFile(path, { env = process.env, override = false } = {}) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, parsed: {} }
    throw error
  }

  const parsed = parseEnvText(text)
  for (const [key, value] of Object.entries(parsed)) {
    if (override || env[key] === undefined) env[key] = value
  }

  return { loaded: true, parsed }
}
