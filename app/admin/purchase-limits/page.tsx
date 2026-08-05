import type { Metadata } from 'next'

import { PublishRuleForm } from '@/components/admin/limit-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requirePermission } from '@/lib/auth/dal'
import { cannabisClass } from '@/lib/db/schema'
import { effectiveRules, ruleHistory, type RuleHistoryRow } from '@/lib/orders/limit-admin'

export const metadata: Metadata = {
  title: 'Purchase limits',
  robots: { index: false, follow: false },
}

/**
 * Purchase limit administration.
 *
 * Gated on the `compliance_admin` grant rather than on the admin role. An
 * administrator who has not been granted it gets a 403 here, which is the
 * intended behaviour and not a misconfiguration — see `lib/db/schema/
 * permissions.ts` for why the two are kept apart.
 *
 * The page is one `<main>` owned by the page itself, matching every other admin
 * route. The account-page failure in Phase 3.5 came from a layout owning
 * `<main>` while an async page streamed into it; nothing here repeats that
 * shape, and `scripts/verify-limit-admin.mjs` checks the rendered DOM in a real
 * browser rather than trusting the HTML string.
 */

const STATE_TONE = {
  effective: 'volt',
  scheduled: 'ember',
  cancelled: 'smoke',
  superseded: 'outline',
} as const

const STATE_LABEL = {
  effective: 'In force',
  scheduled: 'Scheduled',
  cancelled: 'Cancelled before taking effect',
  superseded: 'Superseded',
} as const

function formatWhen(value: Date | null) {
  if (!value) return '—'
  return value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function HistoryRow({ rule }: { rule: RuleHistoryRow }) {
  return (
    <div className="border-t border-ink-600 py-4 first:border-t-0">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-white">
          {rule.cannabisClass} · v{rule.version}
        </span>
        <Badge variant={STATE_TONE[rule.state]}>{STATE_LABEL[rule.state]}</Badge>
        {rule.citedByLines > 0 && (
          <span className="font-mono text-xs text-smoke">
            cited by {rule.citedByLines} order line
            {rule.citedByLines === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-smoke sm:grid-cols-4">
        <div>
          <dt className="inline">factor </dt>
          <dd className="inline text-white">{rule.equivalentGramsPerGram}</dd>
        </div>
        <div>
          <dt className="inline">cap </dt>
          <dd className="inline text-white">{rule.dailyEquivalentGramsCap}g</dd>
        </div>
        <div>
          <dt className="inline">concentrate </dt>
          <dd className="inline text-white">
            {rule.dailyConcentrateGramsCap ? `${rule.dailyConcentrateGramsCap}g` : 'none'}
          </dd>
        </div>
        <div>
          <dt className="inline">by </dt>
          <dd className="inline text-white">{rule.publishedByEmail ?? 'seed script'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="inline">from </dt>
          <dd className="inline text-white">{formatWhen(rule.effectiveFrom)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="inline">until </dt>
          <dd className="inline text-white">{formatWhen(rule.effectiveUntil)}</dd>
        </div>
      </dl>

      <p className="mt-2 text-sm text-smoke">
        {rule.changeReason ?? (
          <span className="italic">
            No reason recorded — published before reasons were required.
          </span>
        )}
      </p>
    </div>
  )
}

export default async function AdminPurchaseLimitsPage() {
  await requirePermission('compliance_admin')

  const [live, history] = await Promise.all([effectiveRules(), ruleHistory()])

  const currentForForm = live.map((rule) => ({
    cannabisClass: rule.cannabisClass,
    version: rule.version,
    equivalentGramsPerGram: rule.equivalentGramsPerGram,
    dailyEquivalentGramsCap: rule.dailyEquivalentGramsCap,
    dailyConcentrateGramsCap: rule.dailyConcentrateGramsCap,
  }))

  const missing = cannabisClass.enumValues.filter(
    (name) => !live.some((rule) => rule.cannabisClass === name),
  )

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Purchase limits
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        The daily caps enforced at checkout. Rules are versioned and permanent:
        publishing a change inserts a new version and closes the previous one.
        Nothing on this page can be edited or deleted.
      </p>

      {missing.length > 0 && (
        <div className="mb-6">
          <Alert tone="warning" title="Some classes have no rule in force">
            {missing.join(', ')} — products in these classes contribute nothing
            to any cap until a rule is published.
          </Alert>
        </div>
      )}

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>In force now</CardTitle>
        </CardHeader>
        <CardContent>
          {live.length === 0 ? (
            <p className="text-sm text-smoke">
              No rules are in force. Checkout is using the fallback values
              compiled into the application.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse font-mono text-sm">
                <thead>
                  <tr className="border-b-2 border-ink text-left text-xs tracking-widest text-smoke uppercase">
                    <th className="py-2 pr-4 font-normal">Class</th>
                    <th className="py-2 pr-4 font-normal">Ver</th>
                    <th className="py-2 pr-4 font-normal">Factor</th>
                    <th className="py-2 pr-4 font-normal">Daily cap</th>
                    <th className="py-2 pr-4 font-normal">Concentrate</th>
                    <th className="py-2 font-normal">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((rule) => (
                    <tr key={rule.id} className="border-b border-ink-600 text-white">
                      <td className="py-2 pr-4">{rule.cannabisClass}</td>
                      <td className="py-2 pr-4">v{rule.version}</td>
                      <td className="py-2 pr-4">{rule.equivalentGramsPerGram}</td>
                      <td className="py-2 pr-4">{rule.dailyEquivalentGramsCap}g</td>
                      <td className="py-2 pr-4">
                        {rule.dailyConcentrateGramsCap
                          ? `${rule.dailyConcentrateGramsCap}g`
                          : 'none'}
                      </td>
                      <td className="py-2">{formatWhen(rule.effectiveFrom)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Publish a change</CardTitle>
        </CardHeader>
        <CardContent>
          <PublishRuleForm
            classes={cannabisClass.enumValues}
            current={currentForForm}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Full history</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-smoke">
            Every version ever published, including scheduled changes and ones
            cancelled before they took effect. Order lines reference the exact
            version they were checked against, which is why none of these can be
            removed.
          </p>
          {history.map((rule) => (
            <HistoryRow key={rule.id} rule={rule} />
          ))}
        </CardContent>
      </Card>
    </main>
  )
}
