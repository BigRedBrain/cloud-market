import type { Metadata } from 'next'

import {
  CloudClusterBanner,
  GlowingHeadline,
} from '@/components/brand/cloud-cluster-banner'
import { CloudMarketMascot } from '@/components/brand/cloudmarket-mascot'
import { FireAccent } from '@/components/brand/fire-accent'
import { HeaderCloudFireStrip } from '@/components/brand/header-cloud-fire-strip'
import { Logo } from '@/components/brand/logo'
import { SmokeBackground } from '@/components/brand/smoke-background'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Gate prototype',
  // Visual prototype, not a storefront page and not the real gate.
  robots: { index: false, follow: false },
}

/**
 * CloudMarket private gate — VISUAL PROTOTYPE.
 *
 * Presentation only. This route does not gate anything: it renders no forms,
 * reads no session, touches no database, and enforces no access control. `/`
 * remains the live homepage and `proxy.ts` is untouched. The three access
 * choices are deliberately inert — see the note beside them.
 *
 * This is the first place the approved system appears together, so the
 * restraint matters more than the inventory. Four primitives carry it:
 * the header strip for context, the mascot as the single figurative moment,
 * one cloud banner for the headline, and small fire accents on the cards.
 * Deliberately unused: CloudProductFrame (a commerce component), LoadingCloud
 * (nothing is loading), CloudButton (its one-per-screen rule would fight three
 * equal-weight choices).
 */

/** The three ways into the marketplace, per the master spec's §13 gate. */
const ACCESS_CHOICES = [
  {
    id: 'shop',
    eyebrow: 'For shoppers',
    title: 'Apply to Shop',
    body: 'Tell us who you are and where you are. A CloudMarket admin reviews every application before marketplace access is granted.',
    cta: 'Apply to shop',
    variant: 'primary' as const,
    accent: true,
  },
  {
    id: 'vend',
    eyebrow: 'For vendors',
    title: 'Apply to Vend',
    body: 'Bring your brand to the marketplace. Vendor applications ask for business details and any licensing your jurisdiction requires.',
    cta: 'Apply to vend',
    variant: 'paper' as const,
    accent: false,
  },
  {
    id: 'invite',
    eyebrow: 'Already invited',
    title: 'Enter Invite Code',
    body: 'Got a code from a member or a vendor? Redeem it to skip the queue and set up your account.',
    cta: 'Enter invite code',
    variant: 'outline' as const,
    accent: false,
  },
]

export default function GatePrototypePage() {
  return (
    <main className="flex flex-1 flex-col bg-dark-smoke">
      {/* ---- Identity bar ------------------------------------------------ */}
      <div className="relative isolate border-b-[3px] border-dark-smoke-deep">
        <HeaderCloudFireStrip
          intensity="ambient"
          className="h-full opacity-20 sm:opacity-25 lg:opacity-30"
        />
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo variant="full" tone="cream" />
          <Badge variant="outline">Prototype</Badge>
        </div>
      </div>

      {/* ---- Hero -------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden">
        <SmokeBackground intensity="hero" />

        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
          {/*
           * The mascot is the page's one figurative moment. Static approved
           * artwork — no rigging, no new animation — and `decorative`, because
           * the headline immediately below says the same thing in words.
           * Capped narrow on phones so it never dominates the viewport.
           */}
          <div className="flex justify-center">
            <CloudMarketMascot
              variant="primary"
              decorative
              sizes="(min-width: 640px) 224px, 144px"
              className="w-36 sm:w-56"
            />
          </div>

          <CloudClusterBanner seed={11} count={5} className="mt-4">
            <GlowingHeadline as="h1" glowColor="var(--signal-yellow)">
              Private marketplace. Cloud 9 access only.
            </GlowingHeadline>
            <p className="mt-3 font-ui text-sm leading-relaxed text-ink opacity-80">
              CloudMarket is members only. Apply as a shopper or a vendor, or
              redeem an invite code.
            </p>
          </CloudClusterBanner>
        </div>
      </section>

      {/* ---- Access choices ---------------------------------------------- */}
      <section
        aria-labelledby="access-heading"
        className="mx-auto w-full max-w-6xl px-4 pb-14 sm:px-6"
      >
        <div className="mb-6 flex flex-col gap-2">
          <p className="font-data text-xs tracking-[0.2em] text-signal-yellow uppercase">
            Three ways in
          </p>
          <h2
            id="access-heading"
            className="font-poster text-3xl tracking-tight text-cloud-white uppercase sm:text-4xl"
          >
            Tap in
          </h2>
        </div>

        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ACCESS_CHOICES.map((choice) => (
            <li
              key={choice.id}
              className={[
                'relative flex flex-col overflow-hidden rounded-lg bg-card p-6',
                // Same comic surface language as the live product cards.
                'border-[3px] border-dark-smoke-deep distressed',
                'shadow-[5px_5px_0_0_var(--dark-smoke-deep)]',
              ].join(' ')}
            >
              <div
                aria-hidden="true"
                className="halftone pointer-events-none absolute inset-0 text-smoke-gray opacity-[0.09]"
              />

              <div className="relative flex flex-1 flex-col gap-3">
                {/*
                 * The accent sits inline with the eyebrow rather than on its
                 * own line. Free-floating above the text it read as an orphaned
                 * mark; beside the label it reads as punctuation.
                 */}
                <p className="flex items-center gap-2 font-data text-[0.6875rem] tracking-widest text-smoke-gray uppercase">
                  {choice.accent && <FireAccent size="sm" />}
                  {choice.eyebrow}
                </p>

                <h3 className="font-poster text-2xl leading-tight tracking-tight text-cloud-white uppercase">
                  {choice.title}
                </h3>

                <p className="flex-1 font-ui text-sm leading-relaxed text-smoke-gray">
                  {choice.body}
                </p>

                <div className="pt-2">
                  {/*
                   * Real, focusable controls with no destination and no
                   * handler. A fake href would imply a route that does not
                   * exist; a disabled button would drop out of the tab order
                   * and hide the focus treatment this prototype exists to show.
                   * `aria-describedby` tells assistive tech they are inert.
                   */}
                  <Button
                    type="button"
                    variant={choice.variant}
                    aria-describedby="prototype-note"
                  >
                    {choice.cta}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <p
          id="prototype-note"
          className="mt-5 border-l-4 border-signal-yellow py-1 pl-3 font-ui text-sm text-smoke-gray"
        >
          <strong className="text-cloud-white">Visual prototype.</strong> These
          three controls are not wired to applications, invite redemption, or
          any account behaviour yet — they are here to show the treatment.
        </p>
      </section>

      {/* ---- Trust / compliance ------------------------------------------ */}
      <section className="border-t-[3px] border-dark-smoke-deep bg-ink-800">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <dl className="grid grid-cols-1 gap-6 font-data text-xs sm:grid-cols-3">
            <div>
              <dt className="tracking-widest text-smoke-gray uppercase">
                Access
              </dt>
              <dd className="mt-1 text-cloud-white">
                Application or invite only
              </dd>
            </div>
            <div>
              <dt className="tracking-widest text-smoke-gray uppercase">
                Review
              </dt>
              <dd className="mt-1 text-cloud-white">
                Every application is reviewed
              </dd>
            </div>
            <div>
              <dt className="tracking-widest text-smoke-gray uppercase">
                Eligibility
              </dt>
              <dd className="mt-1 text-cloud-white">
                21+, where legally permitted
              </dd>
            </div>
          </dl>

          <p className="mt-6 max-w-2xl font-ui text-xs leading-relaxed text-smoke-gray">
            Products, prices and vendor inventory stay behind approved
            membership. Nothing on this page is an offer to sell.
          </p>
        </div>
      </section>

      {/* ---- Footer ------------------------------------------------------ */}
      <footer className="border-t-[3px] border-dark-smoke-deep">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo variant="mark" tone="cream" />
          <p className="font-data text-[0.6875rem] text-smoke-gray">
            CloudMarket · private marketplace · prototype route, noindexed
          </p>
        </div>
      </footer>
    </main>
  )
}
