/**
 * Transport-selection safety, in isolation.
 *
 *   npx tsx --conditions=react-server scripts/verify-email-config.ts
 *
 * These are the assertions that cannot be made over HTTP, because they are
 * about what happens when the deployment is MISCONFIGURED — a state a running
 * server is, by definition, not in.
 *
 * WHY IT SPAWNS A CHILD PER CASE. `lib/env` caches its parsed environment in a
 * module-level variable, and Node caches the module. Mutating `process.env` and
 * re-importing would therefore test nothing: the second import returns the
 * first import's answer. Each case gets a genuinely fresh process, which is the
 * only way the environment under test is actually the environment being read.
 *
 * The property under test is the one that matters most in this phase:
 *
 *   PRODUCTION NEVER FALLS BACK TO A NON-SENDING TRANSPORT.
 *
 * A production deployment that quietly printed reset links to a log instead of
 * emailing them would look healthy while every customer waited for mail that
 * never came — and every one of those links, each a live credential, would be
 * sitting in a log aggregator.
 */
import { spawnSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local', quiet: true })

/* ---------------------------------------------------------------- child mode */

if (process.env.EMAIL_CONFIG_CASE) {
  const run = async () => {
    const { sendEmail, activeTransportName } = await import('../lib/email/index')
    const transport = activeTransportName()
    const result = await sendEmail({
      to: 'nobody@example.invalid',
      subject: 'config probe',
      html: '<p>probe</p>',
      text: 'probe',
    })
    /**
     * Sentinel-prefixed, because the console transport legitimately prints the
     * message to stdout — parsing bare stdout would be parsing its output too.
     */
    process.stdout.write(
      `\n__EMAIL_CONFIG_RESULT__${JSON.stringify({
        transport,
        sent: result.ok,
        error: result.ok ? null : result.error,
      })}`,
    )
  }
  void run()
} else {
  /* --------------------------------------------------------------- parent mode */

  let passed = 0
  let failed = 0
  const check = (name: string, ok: boolean, detail = '') => {
    if (ok) {
      passed += 1
      console.log(`  ok    ${name}`)
    } else {
      failed += 1
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  type Outcome = { transport: string; sent: boolean; error: string | null }

  function probe(env: Record<string, string | undefined>): Outcome {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, EMAIL_CONFIG_CASE: '1' }
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'NODE_ENV']) {
      delete childEnv[key]
    }
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value
    }

    const result = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        require.resolve('tsx/cli'),
        '--conditions=react-server',
        __filename,
      ],
      { env: childEnv, encoding: 'utf8' },
    )

    const stdout = result.stdout ?? ''
    const line = stdout
      .split('\n')
      .find((l) => l.includes('__EMAIL_CONFIG_RESULT__'))
    try {
      return JSON.parse(line!.split('__EMAIL_CONFIG_RESULT__')[1]) as Outcome
    } catch {
      return {
        transport: 'crashed',
        sent: false,
        error: `${stdout}\n${result.stderr ?? ''}`.slice(0, 300),
      }
    }
  }

  console.log('Email transport configuration checks')
  console.log('(each case runs in its own process — see the header)\n')

  console.log('[1] Production fails closed')

  const prodConsole = probe({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' })
  check('production REFUSES the console transport', prodConsole.transport === 'misconfigured',
    prodConsole.transport)
  check('and sending returns an error instead of pretending to send', !prodConsole.sent)
  check('the error names the misconfiguration',
    /production/i.test(prodConsole.error ?? ''), prodConsole.error ?? '')

  const prodCapture = probe({ NODE_ENV: 'production', EMAIL_PROVIDER: 'capture' })
  check('production REFUSES the capture transport', prodCapture.transport === 'misconfigured',
    prodCapture.transport)
  check('capture cannot send in production', !prodCapture.sent)

  const prodDefault = probe({ NODE_ENV: 'production', EMAIL_PROVIDER: undefined })
  check('production refuses the DEFAULT (console) too — no silent fallback',
    prodDefault.transport === 'misconfigured', prodDefault.transport)

  const prodNoKey = probe({
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
  })
  check('production with resend but NO credentials refuses to send', !prodNoKey.sent)
  check('and says which variables are missing',
    /RESEND_API_KEY/.test(prodNoKey.error ?? ''), prodNoKey.error ?? '')

  console.log('\n[2] Non-production selects safe defaults')

  const devDefault = probe({ NODE_ENV: 'development', EMAIL_PROVIDER: undefined })
  check('development defaults to console — no credential needed',
    devDefault.transport === 'console', devDefault.transport)
  check('and the console transport reports success without a network call',
    devDefault.sent)

  const devCapture = probe({ NODE_ENV: 'development', EMAIL_PROVIDER: 'capture' })
  check('capture is selectable outside production', devCapture.transport === 'capture',
    devCapture.transport)

  const devResendNoKey = probe({
    NODE_ENV: 'development',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
  })
  check('resend without a key is refused even in development',
    devResendNoKey.transport === 'misconfigured', devResendNoKey.transport)

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  console.log('==========================================================')
  process.exitCode = failed ? 1 : 0
}
