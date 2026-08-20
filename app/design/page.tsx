import type { Metadata } from 'next'
import Image, { type StaticImageData } from 'next/image'
import { Flame, PackageOpen } from 'lucide-react'

import { BurningCloud } from '@/components/brand/burning-cloud'
import { CloudButton } from '@/components/brand/cloud-button'
import { CloudClusterBanner, GlowingHeadline } from '@/components/brand/cloud-cluster-banner'
import { CloudProductFrame } from '@/components/brand/cloud-product-frame'
import { CloudMarketMascot } from '@/components/brand/cloudmarket-mascot'
import { CloudMarketWordmark } from '@/components/brand/cloudmarket-wordmark'
import { FireAccent } from '@/components/brand/fire-accent'
import { HeaderCloudFireStrip } from '@/components/brand/header-cloud-fire-strip'
import { LoadingCloud } from '@/components/brand/loading-cloud'
import { Logo } from '@/components/brand/logo'
import { SmokeBackground } from '@/components/brand/smoke-background'
import { ProductCard, type Product } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Alert, StatusPanel } from '@/components/ui/feedback'
import { Field, Input, Textarea } from '@/components/ui/field'
import { ProductCardSkeleton, Skeleton, Spinner } from '@/components/ui/skeleton'

/*
 * Approved CloudMarket production artwork.
 *
 * Imported statically from the `brand/` archive rather than copied into
 * `public/`. Two reasons: the archive stays the single canonical location for
 * the approved files (nothing is duplicated or altered), and a static import
 * hands next/image the intrinsic dimensions so these previews reserve their box
 * before any bytes arrive. The source files are 1.7–3.3 MB each; next/image
 * serves resized derivatives, so the page does not ship 20 MB of PNG.
 */
import artMasterApproved from '@/brand/source/cloudmarket-master-approved.png'
import artCloudFrameReference from '@/brand/reference/cloudmarket-cloudframe-approved.png'
import artAppIcon from '@/brand/production/icons/cloudmarket-app-icon-primary.png'
import artFaviconSource from '@/brand/production/icons/cloudmarket-favicon-source.png'
import artSocialAvatar from '@/brand/production/icons/cloudmarket-social-avatar.png'
import artPrimaryLogo from '@/brand/production/logo/cloudmarket-primary.png'
import artSubmark from '@/brand/production/logo/cloudmarket-submark.png'
import artWordmark from '@/brand/production/logo/cloudmarket-wordmark.png'
import artMascot from '@/brand/production/mascot/cloudmarket-mascot-primary.png'
import artCloudFireStrip from '@/brand/production/motion/cloudmarket-header-cloud-fire-strip.png'
import artHeaderMascot from '@/brand/production/motion/cloudmarket-header-mascot.png'

export const metadata: Metadata = {
  title: 'CloudMarket Phase A design reference',
  // Internal reference, not a storefront page. Unchanged from the previous
  // version of this route.
  robots: { index: false, follow: false },
}

/* -------------------------------------------------------------------------- */
/* Preview helpers                                                            */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  eyebrow,
  title,
  note,
  children,
}: {
  id: string
  eyebrow: string
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="font-data text-xs tracking-[0.2em] text-signal-yellow uppercase">
          {eyebrow}
        </p>
        <h2 className="font-poster text-3xl tracking-tight uppercase">{title}</h2>
        {note && <p className="max-w-2xl font-ui text-sm text-smoke-gray">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/** A rule the page states rather than merely demonstrates. */
function Rule({
  tone = 'allow',
  children,
}: {
  tone?: 'allow' | 'deny'
  children: React.ReactNode
}) {
  const deny = tone === 'deny'
  return (
    <p
      className={[
        'flex items-start gap-2 border-l-4 py-1 pl-3 font-ui text-sm',
        deny
          ? 'border-fire-red text-cloud-white'
          : 'border-signal-yellow text-smoke-gray',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={`font-data text-xs font-bold ${deny ? 'text-fire-red' : 'text-signal-yellow'}`}
      >
        {deny ? 'NEVER' : 'USE'}
      </span>
      <span>{children}</span>
    </p>
  )
}

function Swatch({
  token,
  label,
  hex,
  role,
  className,
  flag,
}: {
  token: string
  label: string
  hex: string
  role: string
  className: string
  /** Governance note rendered under the swatch, for non-brand colours. */
  flag?: string
}) {
  return (
    // flex column + flex-1 on the info block so every card in a row fills to
    // the tallest one. Roles are different lengths, so without it the dark
    // panel stops short and the row looks ragged.
    <div className="panel-sm flex flex-col overflow-hidden rounded-md">
      <div className={`h-16 w-full shrink-0 ${className}`} />
      <div className="flex-1 bg-dark-smoke p-2.5">
        <p className="font-ui text-xs font-bold text-cloud-white">{label}</p>
        <p className="font-data text-[0.625rem] break-all text-signal-yellow">
          {token}
        </p>
        <p className="font-data text-[0.625rem] text-smoke-gray">{hex}</p>
        <p className="mt-1 font-ui text-[0.6875rem] text-smoke-gray">{role}</p>
        {flag && (
          <p className="mt-1.5 border-t border-ink-600 pt-1.5 font-data text-[0.5625rem] leading-tight tracking-wide text-fire-red uppercase">
            {flag}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Labelled artwork preview.
 *
 * `sizes` is set on every instance because these are multi-megabyte source
 * files; without it next/image would serve a derivative sized for the full
 * viewport into a 300px box.
 */
function AssetCard({
  src,
  name,
  path,
  role,
  surface = 'dark',
  contain = true,
}: {
  src: StaticImageData
  name: string
  path: string
  role: string
  surface?: 'dark' | 'pearl'
  contain?: boolean
}) {
  return (
    <figure className="panel-sm flex flex-col overflow-hidden rounded-md bg-dark-smoke">
      <div
        className={[
          'flex items-center justify-center border-b-2 border-ink p-4',
          surface === 'pearl' ? 'bg-pearl' : 'bg-ink-800',
        ].join(' ')}
      >
        <Image
          src={src}
          alt={`${name} — approved CloudMarket production artwork`}
          sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
          className={contain ? 'h-40 w-auto object-contain' : 'w-full'}
        />
      </div>
      <figcaption className="flex flex-col gap-1 p-3">
        <p className="font-ui text-sm font-bold text-cloud-white">{name}</p>
        <p className="font-data text-[0.625rem] break-all text-smoke-gray">{path}</p>
        <p className="font-ui text-xs text-smoke-gray">{role}</p>
      </figcaption>
    </figure>
  )
}

function ContrastRow({
  pairing,
  ratio,
  verdict,
  sample,
}: {
  pairing: string
  ratio: string
  verdict: 'pass' | 'fail'
  sample: React.ReactNode
}) {
  const pass = verdict === 'pass'
  return (
    <tr className="border-b border-ink-600 last:border-b-0">
      <td className="py-2 pr-3 align-middle">{sample}</td>
      <td className="py-2 pr-3 font-ui text-sm text-cloud-white">{pairing}</td>
      <td className="py-2 pr-3 text-right font-data text-sm font-bold text-cloud-white">
        {ratio}
      </td>
      <td className="py-2 text-right">
        <span
          className={[
            'font-data text-[0.625rem] font-bold tracking-wide uppercase',
            pass ? 'text-status-instock' : 'text-fire-red',
          ].join(' ')}
        >
          {pass ? 'AA pass' : 'Never use'}
        </span>
      </td>
    </tr>
  )
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

const SAMPLE: Product[] = [
  {
    id: '1',
    slug: 'midnight-runtz',
    name: 'Midnight Runtz',
    category: 'Indica · Flower',
    size: '3.5g',
    thcPercent: 27.4,
    priceCents: 4500,
    inStock: true,
  },
  {
    id: '2',
    slug: 'motor-city-haze',
    name: 'Motor City Haze',
    category: 'Sativa · Flower',
    size: '3.5g',
    thcPercent: 22.1,
    priceCents: 3800,
    inStock: true,
    stockCount: 2,
  },
  {
    id: '3',
    slug: 'eastside-og',
    name: 'Eastside OG',
    category: 'Hybrid · Flower',
    size: '7g',
    thcPercent: 24.9,
    priceCents: 7200,
    inStock: false,
  },
]

/** The six approved CloudMarket brand colours, plus Dark Smoke Deep. */
const BRAND_SWATCHES = [
  {
    token: '--cloud-white',
    label: 'Cloud White',
    hex: '#ffffff',
    role: 'High-contrast text on dark',
    className: 'bg-cloud-white',
  },
  {
    token: '--pearl',
    label: 'Pearl',
    hex: '#f2ece0',
    role: 'Content surfaces, cloud bodies',
    className: 'bg-pearl',
  },
  {
    token: '--dark-smoke',
    label: 'Dark Smoke',
    hex: '#0f0f12',
    role: 'Page foundation, shell, nav',
    className: 'bg-dark-smoke',
  },
  {
    token: '--dark-smoke-deep',
    label: 'Dark Smoke Deep',
    hex: '#030304',
    role: 'Comic ink outlines, hard shadows',
    className: 'bg-dark-smoke-deep',
  },
  {
    token: '--smoke-gray',
    label: 'Smoke Gray',
    hex: '#8c8f94',
    role: 'Secondary text, layered depth',
    className: 'bg-smoke-gray',
  },
  {
    token: '--signal-yellow',
    label: 'Signal Yellow',
    hex: '#f5cf00',
    role: 'Sparks, highlights, selected CTAs',
    className: 'bg-signal-yellow',
  },
  {
    token: '--fire-red',
    label: 'Fire Red',
    hex: '#f93635',
    role: 'Fire, active moments, urgency',
    className: 'bg-fire-red',
  },
]

const GOVERNED_SWATCHES = [
  {
    token: '--ember / --fire-core',
    label: 'Ember',
    hex: '#ff8031',
    role: 'Middle stop of the fire gradient',
    className: 'bg-ember',
    flag: 'Internal fire gradient only — not a brand colour',
  },
  {
    token: '--status-instock',
    label: 'Status green',
    hex: '#3ff873',
    role: 'Availability signal only',
    className: 'bg-status-instock',
    flag: 'Status only — not a CloudMarket brand colour',
  },
]

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function DesignSystemPage() {
  return (
    <>
      <SiteNav bagCount={3} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6">
        {/* ---- 1. Phase A header ------------------------------------------ */}
        <header className="mb-14 flex flex-col gap-5">
          <div className="panel-sm overflow-hidden rounded-lg bg-ink-800">
            <div className="flex items-center justify-center px-6 py-8">
              <Image
                src={artWordmark}
                alt="CloudMarket"
                priority
                sizes="(min-width: 1024px) 640px, 90vw"
                className="h-auto w-full max-w-xl"
              />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="ember" tilt>
                Phase A
              </Badge>
              <Badge variant="outline">Internal preview</Badge>
              <Badge variant="smoke">Noindexed</Badge>
            </div>

            <h1 className="max-w-3xl font-brand text-4xl leading-tight text-cloud-white sm:text-6xl">
              CloudMarket design reference
            </h1>

            <p className="max-w-2xl font-ui text-base leading-relaxed text-smoke-gray">
              The Phase A proving ground for the approved CloudMarket creative
              direction — palette, typography, production artwork, motion
              language, and surfaces. This route is{' '}
              <strong className="text-cloud-white">noindexed and internal</strong>
              . It is a reference, not a storefront: nothing here changes the
              live site, and no component on this page has been restyled in
              production yet.
            </p>

            <p className="max-w-2xl font-ui text-sm leading-relaxed text-smoke-gray">
              Governing documents:{' '}
              {/* break-all: the filename is a single unbreakable token in a
                  monospace face, and at 320px it is wider than the viewport —
                  which pushed the whole document into horizontal scroll. */}
              <span className="font-data break-all text-signal-yellow">
                CLOUDMARKET_MASTER_WEBSITE_APP_SPEC.md
              </span>{' '}
              is the source of truth.{' '}
              <span className="font-data text-smoke-gray">DESIGN.md</span> is
              retained as a superseded engineering reference — its
              accessibility, performance, and interaction rules still apply
              where they do not conflict.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-20">
          {/* ---- 2. Approved colour palette ------------------------------ */}
          <Section
            id="palette"
            eyebrow="Section 02"
            title="Approved colour palette"
            note="Authored in oklch so lightness is perceptually uniform and a tint keeps its hue. Every colour below is a live token — the swatch is filled by the same custom property a component would use."
          >
            <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
              {BRAND_SWATCHES.map((s) => (
                <Swatch key={s.token} {...s} />
              ))}
            </div>

            <div className="mt-2 flex flex-col gap-3">
              <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                Governed colours
              </h3>
              <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                These two exist in the system but are deliberately excluded from
                the brand palette. They are shown here so the boundary is
                visible rather than tribal knowledge.
              </p>
              <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
                {GOVERNED_SWATCHES.map((s) => (
                  <Swatch key={s.token} {...s} />
                ))}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                <Rule>
                  Ember only ever appears between Signal Yellow and Fire Red
                  inside a flame. A gradient that steps straight from yellow to
                  red reads as a warning stripe, not as heat.
                </Rule>
                <Rule tone="deny">
                  Green as a primary, focus, or success brand treatment. It
                  survives in exactly one job — &ldquo;you can buy this right
                  now&rdquo; — reachable only through{' '}
                  <span className="font-data">--status-instock</span>.
                </Rule>
              </div>
            </div>
          </Section>

          {/* ---- 3. Typography ------------------------------------------- */}
          <Section
            id="typography"
            eyebrow="Section 03"
            title="Typography"
            note="Four faces, four jobs, no overlap. The semantic names below are the ones new work should use; they resolve to the same families already loaded."
          >
            <Card className="p-6">
              <div className="flex flex-col gap-8">
                <div>
                  <p className="mb-2 font-data text-[0.625rem] tracking-widest text-signal-yellow uppercase">
                    Permanent Marker · font-brand · brand moments
                  </p>
                  <p className="font-brand text-4xl leading-tight text-cloud-white sm:text-5xl">
                    Private marketplace. Cloud 9 access only.
                  </p>
                  <p className="mt-3 font-ui text-sm text-smoke-gray">
                    Hero headlines, comic callouts, promotional display type.
                    Never tightened — the global heading rule that tracks h1–h3
                    at −0.01em is cancelled for this face, because marker
                    strokes already touch.
                  </p>
                </div>

                <div className="border-t border-ink-600 pt-6">
                  <p className="mb-2 font-data text-[0.625rem] tracking-widest text-signal-yellow uppercase">
                    Anton · font-poster · section headings
                  </p>
                  <p className="font-poster text-4xl leading-none tracking-tight text-cloud-white uppercase">
                    Featured drops
                  </p>
                  <p className="mt-3 font-ui text-sm text-smoke-gray">
                    Carries flyer energy at heading scale, where Permanent
                    Marker would shout. Never below 1.5rem, never for prose.
                  </p>
                </div>

                <div className="border-t border-ink-600 pt-6">
                  <p className="mb-2 font-data text-[0.625rem] tracking-widest text-signal-yellow uppercase">
                    Archivo · font-ui · body, forms, navigation, dashboards
                  </p>
                  <p className="max-w-2xl font-ui text-base leading-relaxed text-cloud-white">
                    Approved members can browse the full catalog, follow
                    vendors, and build a watchlist. Applications are reviewed by
                    a CloudMarket admin before marketplace access is granted.
                  </p>
                  <p className="mt-3 font-ui text-sm text-smoke-gray">
                    Everything readable. Large x-height holds up at 14–16px on a
                    phone at night.
                  </p>
                </div>

                <div className="border-t border-ink-600 pt-6">
                  <p className="mb-2 font-data text-[0.625rem] tracking-widest text-signal-yellow uppercase">
                    Space Mono · font-data · prices, potency, codes
                  </p>
                  <dl className="flex flex-wrap gap-x-8 gap-y-3">
                    <div>
                      <dt className="font-ui text-xs text-smoke-gray">Price</dt>
                      <dd className="font-data text-2xl font-bold text-cloud-white">
                        $42.00
                      </dd>
                    </div>
                    <div>
                      <dt className="font-ui text-xs text-smoke-gray">THC</dt>
                      <dd className="font-data text-2xl font-bold text-cloud-white">
                        27.4%
                      </dd>
                    </div>
                    <div>
                      <dt className="font-ui text-xs text-smoke-gray">CBD</dt>
                      <dd className="font-data text-2xl font-bold text-cloud-white">
                        0.8%
                      </dd>
                    </div>
                    <div>
                      <dt className="font-ui text-xs text-smoke-gray">
                        Invite code
                      </dt>
                      <dd className="font-data text-2xl font-bold tracking-[0.2em] text-cloud-white">
                        9CLD-4F2X
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 font-ui text-sm text-smoke-gray">
                    Fixed advance widths stop totals jittering as they update,
                    and a mis-read invite code is a support ticket.
                  </p>
                </div>
              </div>
            </Card>

            <div className="flex flex-col gap-2">
              <Rule>
                Permanent Marker for CloudMarket brand moments, hero headlines,
                comic callouts, and major branded display text.
              </Rule>
              <Rule tone="deny">
                Permanent Marker for prices, THC/CBD values, inventory, forms,
                legal or compliance copy, admin and vendor table data, long
                prose, or small utility text. Critical data is never carried by
                the brand face alone.
              </Rule>
            </div>
          </Section>

          {/* ---- 4. Approved artwork ------------------------------------- */}
          <Section
            id="artwork"
            eyebrow="Section 04"
            title="Approved production artwork"
            note="Rendered directly from the brand/ archive. Nothing here has been redrawn, recoloured, cropped, or regenerated — these are the approved files, resized for display only."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <AssetCard
                src={artPrimaryLogo}
                name="Primary logo"
                path="brand/production/logo/cloudmarket-primary.png"
                role="Full scene: mascot, cart, cloud base, wordmark"
              />
              <AssetCard
                src={artWordmark}
                name="Wordmark"
                path="brand/production/logo/cloudmarket-wordmark.png"
                role="Brush wordmark with fire and smoke — header lockup"
              />
              <AssetCard
                src={artSubmark}
                name="Submark"
                path="brand/production/logo/cloudmarket-submark.png"
                role="Circular badge — mascot head in cloud ring"
              />
              <AssetCard
                src={artMascot}
                name="Primary mascot"
                path="brand/production/mascot/cloudmarket-mascot-primary.png"
                role="Bud mascot pushing the cart — hero pose"
              />
              <AssetCard
                src={artAppIcon}
                name="App icon"
                path="brand/production/icons/cloudmarket-app-icon-primary.png"
                role="Opaque rounded square — wired to app/apple-icon.png"
              />
              <AssetCard
                src={artSocialAvatar}
                name="Social avatar"
                path="brand/production/icons/cloudmarket-social-avatar.png"
                role="Mascot head and shoulders in cloud ring"
              />
              <AssetCard
                src={artFaviconSource}
                name="Favicon source"
                path="brand/production/icons/cloudmarket-favicon-source.png"
                role="Source for the 16/32/48 favicon pack and app/icon.png"
              />
              <AssetCard
                src={artHeaderMascot}
                name="Header mascot"
                path="brand/production/motion/cloudmarket-header-mascot.png"
                role="Wide traverse artwork — red/yellow fire variant"
              />
              <AssetCard
                src={artCloudFireStrip}
                name="Header cloud/fire strip"
                path="brand/production/motion/cloudmarket-header-cloud-fire-strip.png"
                role="Environment strip with centre negative space for nav"
              />
            </div>

            <details className="panel-sm rounded-md bg-ink-800 p-4">
              <summary className="cursor-pointer font-ui text-sm font-bold text-cloud-white">
                Source master (approved reference artwork)
              </summary>
              <div className="mt-4 flex flex-col gap-3">
                <div className="flex justify-center rounded-md bg-dark-smoke p-4">
                  <Image
                    src={artMasterApproved}
                    alt="CloudMarket approved master artwork"
                    sizes="(min-width: 1024px) 700px, 90vw"
                    className="h-auto w-full max-w-2xl"
                  />
                </div>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  brand/source/cloudmarket-master-approved.png
                </p>
                <p className="font-ui text-sm text-smoke-gray">
                  The designated visual reference for mascot appearance and
                  attitude, the shopping-cart concept, cloud/smoke/fire
                  treatment, and illustration energy. Production derivatives may
                  simplify detail but must remain recognisably derived from it.
                </p>
              </div>
            </details>
          </Section>

          {/* ---- 5. Motion language -------------------------------------- */}
          <Section
            id="motion"
            eyebrow="Section 05"
            title="Motion language"
            note="Floating through Cloud 9. Every effect below is CSS transform and opacity only — no JavaScript animation runtime, no blur on large elements, no feTurbulence. Named durations come from the motion tokens."
          >
            <div className="grid gap-3 lg:grid-cols-2">
              {/* Floating clouds */}
              <div className="panel relative isolate flex h-64 flex-col justify-end overflow-hidden rounded-lg bg-dark-smoke">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 -z-10 [contain:strict]"
                >
                  <div
                    className="absolute -inset-1/4 animate-[smoke-drift-a_37s_ease-in-out_infinite_alternate] motion-reduce:animate-none"
                    style={{
                      background:
                        'radial-gradient(42% 34% at 26% 68%, oklch(0.945 0.018 85 / 18%), transparent 70%)',
                    }}
                  />
                  <div
                    className="absolute -inset-1/4 animate-[smoke-drift-b_43s_ease-in-out_infinite_alternate] motion-reduce:animate-none"
                    style={{
                      background:
                        'radial-gradient(48% 40% at 68% 40%, oklch(1 0 0 / 12%), transparent 72%)',
                    }}
                  />
                  <div
                    className="absolute -inset-1/4 animate-[smoke-drift-c_53s_ease-in-out_infinite_alternate] motion-reduce:animate-none"
                    style={{
                      background:
                        'radial-gradient(38% 32% at 48% 92%, oklch(0.648 0.008 262 / 16%), transparent 68%)',
                    }}
                  />
                </div>
                <div className="p-4">
                  <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Floating clouds
                  </p>
                  <p className="font-data text-xs text-smoke-gray">
                    3 layers · 37s / 43s / 53s · co-prime, never loops in sync
                  </p>
                </div>
              </div>

              {/* Smoke drift — the live production component */}
              <div className="panel relative isolate flex h-64 flex-col justify-end overflow-hidden rounded-lg bg-dark-smoke">
                <SmokeBackground intensity="hero" />
                <div className="p-4">
                  <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Smoke drift
                  </p>
                  <p className="font-data text-xs text-smoke-gray">
                    SmokeBackground · server component · 0 KB JS
                  </p>
                </div>
              </div>

              {/* Flame flicker */}
              <div className="panel flex h-64 flex-col justify-between overflow-hidden rounded-lg bg-ink-800 p-4">
                <div className="flex flex-1 items-end justify-center">
                  <svg
                    viewBox="0 0 180 90"
                    aria-hidden="true"
                    className="h-32 w-auto"
                  >
                    <defs>
                      <linearGradient
                        id="design-flame-gradient"
                        x1="0"
                        y1="1"
                        x2="0"
                        y2="0"
                      >
                        <stop offset="0%" stopColor="var(--fire-base)" />
                        <stop offset="55%" stopColor="var(--fire-core)" />
                        <stop offset="100%" stopColor="var(--fire-tip)" />
                      </linearGradient>
                    </defs>
                    {[
                      { d: 'M30 88 C22 66 48 58 40 34 C64 56 56 76 30 88 Z', delay: '0s' },
                      { d: 'M88 90 C78 62 108 52 98 24 C128 52 118 76 88 90 Z', delay: '0.25s' },
                      { d: 'M146 88 C138 68 160 60 152 38 C174 58 166 76 146 88 Z', delay: '0.5s' },
                    ].map((flame) => (
                      <path
                        key={flame.d}
                        d={flame.d}
                        fill="url(#design-flame-gradient)"
                        stroke="var(--dark-smoke-deep)"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        className="animate-[ember-flicker_900ms_ease-in-out_infinite] motion-reduce:animate-none"
                        style={{
                          transformOrigin: 'center bottom',
                          animationDelay: flame.delay,
                        }}
                      />
                    ))}
                  </svg>
                </div>
                <div>
                  <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Flame flicker
                  </p>
                  <p className="font-data text-xs text-smoke-gray">
                    Signal Yellow → Ember → Fire Red · scaleY + opacity · 900ms
                  </p>
                </div>
              </div>

              {/* Mascot traverse — deliberately static */}
              <div className="panel flex h-64 flex-col justify-between overflow-hidden rounded-lg bg-ink-800">
                <div className="relative flex flex-1 items-center overflow-hidden">
                  <Image
                    src={artHeaderMascot}
                    alt=""
                    aria-hidden="true"
                    sizes="(min-width: 1024px) 560px, 90vw"
                    className="h-auto w-full opacity-90"
                  />
                </div>
                <div className="border-t-2 border-ink p-4">
                  <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Mascot / header movement
                  </p>
                  <p className="font-data text-xs text-smoke-gray">
                    Static preview · intended: ~12s traverse (--motion-mascot)
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Rule>
                Reduced motion is an alternative, not a removal. Every keyframe
                is declared inside{' '}
                <span className="font-data">
                  prefers-reduced-motion: no-preference
                </span>
                , and every resting state is the finished frame — so the
                composition arrives complete and simply holds still.
              </Rule>
              <Rule tone="deny">
                Animating the mascot artwork as a looping raster. The traverse
                stays static until a layered SVG rig exists with independently
                addressable body, cart, arms, cloud, and flame groups.
              </Rule>
            </div>

            <Card className="p-5">
              <p className="mb-3 font-poster text-lg tracking-tight text-cloud-white uppercase">
                Motion tokens
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-data text-xs sm:grid-cols-3">
                {[
                  ['--motion-instant', '100ms', 'press'],
                  ['--motion-fast', '150ms', 'hover, lift'],
                  ['--motion-base', '250ms', 'panel transitions'],
                  ['--motion-entrance', '400ms', 'fade-in'],
                  ['--motion-brand', '1100ms', 'flame grow, ink-draw'],
                  ['--motion-mascot', '12s', 'cart traverse'],
                  ['--motion-drift-a', '37s', 'cloud layer 1'],
                  ['--motion-drift-b', '43s', 'cloud layer 2'],
                  ['--motion-drift-c', '53s', 'cloud layer 3'],
                ].map(([token, value, role]) => (
                  <div key={token} className="flex flex-col">
                    <dt className="text-signal-yellow">{token}</dt>
                    <dd className="text-cloud-white">
                      {value}{' '}
                      <span className="text-smoke-gray">· {role}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </Section>

          {/* ---- 6. CloudMarket surfaces --------------------------------- */}
          <Section
            id="surfaces"
            eyebrow="Section 06"
            title="CloudMarket surfaces"
            note="The structural vocabulary: what a panel is made of. The grit is structural — outlines, panels, stickers — rather than filter-based, which is what keeps it premium and cheap to render."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="panel flex h-40 flex-col justify-end rounded-lg bg-dark-smoke p-4">
                <p className="font-ui text-sm font-bold text-cloud-white">
                  Dark Smoke foundation
                </p>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  --dark-smoke · page shell
                </p>
              </div>

              <div className="panel flex h-40 flex-col justify-end rounded-lg bg-pearl p-4">
                <p className="font-ui text-sm font-bold text-ink">
                  Pearl content surface
                </p>
                <p className="font-data text-[0.625rem] text-ink/70">
                  --pearl · receipts, legal, summaries
                </p>
              </div>

              <div className="panel flex h-40 flex-col justify-end rounded-lg bg-cloud-white p-4">
                <p className="font-ui text-sm font-bold text-ink">
                  Cloud White surface
                </p>
                <p className="font-data text-[0.625rem] text-ink/70">
                  --cloud-white · cloud bodies, bright panels
                </p>
              </div>

              <div className="flex h-40 flex-col justify-end rounded-lg border-2 border-dark-smoke-deep bg-ink-800 p-4">
                <p className="font-ui text-sm font-bold text-cloud-white">
                  Comic ink outline
                </p>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  2px --dark-smoke-deep · no shadow
                </p>
              </div>

              <div className="panel flex h-40 flex-col justify-end rounded-lg bg-ink-800 p-4">
                <p className="font-ui text-sm font-bold text-cloud-white">
                  Hard offset shadow
                </p>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  5px 5px 0 · zero blur is the point
                </p>
              </div>

              <div className="panel relative flex h-40 flex-col justify-end overflow-hidden rounded-lg bg-ink-800 p-4">
                <div
                  aria-hidden="true"
                  className="halftone-lg pointer-events-none absolute inset-0 text-smoke-gray opacity-40"
                />
                <div
                  aria-hidden="true"
                  className="distressed pointer-events-none absolute inset-0"
                />
                <p className="relative font-ui text-sm font-bold text-cloud-white">
                  Halftone + distressed
                </p>
                <p className="relative font-data text-[0.625rem] text-smoke-gray">
                  CSS gradients · no noise filter
                </p>
              </div>

              <div
                className="panel flex h-40 flex-col justify-end rounded-lg p-4"
                style={{ backgroundImage: 'var(--fire-gradient)' }}
              >
                <p className="font-ui text-sm font-bold text-ink">Fire accent</p>
                <p className="font-data text-[0.625rem] text-ink/75">
                  --fire-gradient · ink text on every bright fill
                </p>
              </div>

              <div className="panel flex h-40 flex-col items-center justify-center gap-3 rounded-lg bg-ink-800 p-4">
                <Logo variant="mark" tone="cream" className="[&_svg]:h-12" />
                <div className="text-center">
                  <p className="font-ui text-sm font-bold text-cloud-white">
                    Cloud treatment
                  </p>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    One silhouette, every scale
                  </p>
                </div>
              </div>

              <div className="panel flex h-40 flex-col items-center justify-center gap-3 rounded-lg border-dashed bg-ink-800 p-4 text-center">
                <Flame aria-hidden="true" className="size-6 text-signal-yellow" />
                <p className="font-ui text-sm font-bold text-cloud-white">
                  Cloud card frame
                </p>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  Pending Phase A asset — not yet produced
                </p>
              </div>
            </div>

            <Rule tone="deny">
              A cloud frame so elaborate that product names and prices are hard
              to scan. The frame is drawn behind an ordinary rectangular content
              box; text is never clipped to a lobed path.
            </Rule>
          </Section>

          {/* ---- 7. Existing UI components ------------------------------- */}
          <Section
            id="components"
            eyebrow="Section 07"
            title="Existing UI components"
            note="Rendered exactly as they ship today, against the new semantic tokens. None of these has been restyled — this is the current baseline the CloudMarket treatment will be applied to in a later step."
          >
            <div className="flex flex-col gap-8">
              <Card className="flex flex-col gap-6 p-6">
                <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Buttons
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary">Apply to shop</Button>
                  <Button variant="confirm">Confirm</Button>
                  <Button variant="destructive">Revoke invite</Button>
                  <Button variant="paper">View drop</Button>
                  <Button variant="outline">Keep browsing</Button>
                  <Button variant="ghost">Cancel</Button>
                  <Button disabled>Unavailable</Button>
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-ink-600 pt-6">
                  <Button size="sm">Small</Button>
                  <Button size="md">Medium</Button>
                  <Button size="lg">Large</Button>
                  <Button size="icon" aria-label="Add">
                    <Flame />
                  </Button>
                  <Button>
                    <Spinner label="Submitting" />
                    Submitting
                  </Button>
                </div>
              </Card>

              <Card className="flex flex-col gap-4 p-6">
                <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Badges
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="volt">In stock</Badge>
                  <Badge variant="ember">
                    <Flame aria-hidden="true" />
                    Top shelf
                  </Badge>
                  <Badge variant="flare">Last 3</Badge>
                  <Badge variant="cream">New drop</Badge>
                  <Badge variant="smoke">Hybrid I</Badge>
                  <Badge variant="outline">Lab tested</Badge>
                  <Badge variant="ember" tilt>
                    Featured
                  </Badge>
                </div>
              </Card>

              <div className="grid gap-3 lg:grid-cols-2">
                <Card className="p-6">
                  <p className="mb-5 font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Fields
                  </p>
                  <div className="flex flex-col gap-5">
                    <Field
                      id="demo-name"
                      label="Full name"
                      hint="As it appears on your state ID."
                      required
                    >
                      {(props) => <Input placeholder="Jordan Ellis" {...props} />}
                    </Field>
                    <Field
                      id="demo-jurisdiction"
                      label="State / jurisdiction"
                      error="We're not accepting applications from this state yet."
                      required
                    >
                      {(props) => <Input placeholder="Michigan" {...props} />}
                    </Field>
                    <Field id="demo-notes" label="Anything else?">
                      {(props) => (
                        <Textarea placeholder="Tell us how you heard about CloudMarket" {...props} />
                      )}
                    </Field>
                  </div>
                </Card>

                <div className="flex flex-col gap-3">
                  <Alert tone="error" title="Invite code not valid">
                    Check the code and try again.
                  </Alert>
                  <Alert tone="warning" title="Application needs information">
                    We need a clearer photo of your licence before we can
                    continue the review.
                  </Alert>
                  <Alert tone="success" title="Application approved">
                    Welcome to CloudMarket. Your marketplace access is active.
                  </Alert>
                  <Alert tone="info" title="Review takes 1–2 business days">
                    We&apos;ll email you as soon as a decision is made.
                  </Alert>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <StatusPanel
                  tone="success"
                  title="You're in"
                  description="Your shopper application was approved. Tap in to enter the market."
                  reference={{ label: 'Member number', value: 'CM-4821-Q7' }}
                  action={<Button variant="paper">Enter the market</Button>}
                />
                <StatusPanel
                  tone="error"
                  title="We can't approve this yet"
                  description="Your jurisdiction is outside the areas CloudMarket currently serves."
                  action={<Button variant="primary">Read the rules</Button>}
                />
              </div>

              <div>
                <p className="mb-4 font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Product cards · current baseline
                </p>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  <ProductCard
                    product={SAMPLE[0]}
                    badge={{ label: 'Top shelf', variant: 'ember' }}
                  />
                  <ProductCard product={SAMPLE[1]} badge={{ label: 'New drop' }} />
                  <ProductCard product={SAMPLE[2]} />
                </div>
              </div>

              <div>
                <p className="mb-4 font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Loading and empty
                </p>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  <ProductCardSkeleton />
                  <Card className="flex flex-col gap-3 p-4">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </Card>
                  <EmptyState
                    icon={<PackageOpen />}
                    title="Nothing on your watchlist yet"
                    description="Follow a drop and it shows up here."
                    action={<Button variant="primary">Browse the market</Button>}
                  />
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <Card className="flex flex-wrap items-center justify-center gap-8 p-10">
                  <CloudButton size="sm">Tap in</CloudButton>
                  <CloudButton size="md">Enter invite code</CloudButton>
                </Card>
                <Card className="flex items-center justify-center p-8">
                  <div className="w-52">
                    <BurningCloud />
                  </div>
                </Card>
              </div>

              <div>
                <p className="mb-4 font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Paper panel
                </p>
                <Card surface="paper" className="max-w-md">
                  <CardHeader>
                    <CardTitle>Application summary</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 font-data text-sm">
                    <div className="flex justify-between">
                      <span>Applicant</span>
                      <span>Jordan Ellis</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Type</span>
                      <span>Shopper</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Submitted</span>
                      <span>2026-08-17</span>
                    </div>
                    <div className="mt-2 flex justify-between border-t-2 border-ink pt-2 text-base font-bold">
                      <span>Status</span>
                      <span>Under review</span>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="flex items-center justify-center p-8">
                  <Logo variant="full" />
                </Card>
                <Card className="flex items-center justify-center p-8">
                  <Logo variant="stacked" />
                </Card>
                <Card surface="paper" className="flex items-center justify-center p-8">
                  <Logo variant="full" tone="ink" />
                </Card>
              </div>
            </div>
          </Section>

          {/* ---- 8. Contrast / accessibility ----------------------------- */}
          <Section
            id="contrast"
            eyebrow="Section 08"
            title="Contrast and accessibility"
            note="One rule carries most of it: every bright fill takes ink text, never Pearl or Cloud White. Ratios below are computed from the compiled token values, not estimated."
          >
            <Card className="overflow-x-auto p-5">
              <table className="w-full min-w-125">
                <caption className="sr-only">
                  Approved and forbidden colour pairings with contrast ratios
                </caption>
                <thead>
                  <tr className="border-b-2 border-ink text-left">
                    <th scope="col" className="pb-2 font-ui text-xs font-normal text-smoke-gray">
                      Sample
                    </th>
                    <th scope="col" className="pb-2 font-ui text-xs font-normal text-smoke-gray">
                      Pairing
                    </th>
                    <th scope="col" className="pb-2 text-right font-ui text-xs font-normal text-smoke-gray">
                      Ratio
                    </th>
                    <th scope="col" className="pb-2 text-right font-ui text-xs font-normal text-smoke-gray">
                      Verdict
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <ContrastRow
                    pairing="Ink on Signal Yellow"
                    ratio="13.53"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-signal-yellow px-2 py-1 font-ui text-xs font-bold text-ink">
                        Tap in
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Cloud White on Dark Smoke"
                    ratio="19.10"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-dark-smoke px-2 py-1 font-ui text-xs font-bold text-cloud-white">
                        Body text
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Pearl on Dark Smoke"
                    ratio="16.26"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-dark-smoke px-2 py-1 font-ui text-xs font-bold text-pearl">
                        Body text
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Signal Yellow text on Dark Smoke"
                    ratio="12.53"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-dark-smoke px-2 py-1 font-ui text-xs font-bold text-signal-yellow">
                        Highlight
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Ink on Fire Red"
                    ratio="5.49"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-fire-red px-2 py-1 font-ui text-xs font-bold text-ink">
                        Revoke
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Fire Red text on panel"
                    ratio="4.60"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-ink-800 px-2 py-1 font-ui text-xs font-bold text-fire-red">
                        Error
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Smoke Gray on Dark Smoke"
                    ratio="5.86"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-dark-smoke px-2 py-1 font-ui text-xs font-bold text-smoke-gray">
                        Secondary
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Ink on status green"
                    ratio="14.64"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-status-instock px-2 py-1 font-ui text-xs font-bold text-ink">
                        In stock
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Status green text on panel"
                    ratio="12.28"
                    verdict="pass"
                    sample={
                      <span className="inline-block rounded-sm bg-ink-800 px-2 py-1 font-ui text-xs font-bold text-status-instock">
                        In stock
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Cloud White on Signal Yellow"
                    ratio="1.52"
                    verdict="fail"
                    sample={
                      <span className="inline-block rounded-sm bg-signal-yellow px-2 py-1 font-ui text-xs font-bold text-cloud-white">
                        Tap in
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Pearl on Signal Yellow"
                    ratio="1.30"
                    verdict="fail"
                    sample={
                      <span className="inline-block rounded-sm bg-signal-yellow px-2 py-1 font-ui text-xs font-bold text-pearl">
                        Tap in
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Pearl on Fire Red"
                    ratio="3.20"
                    verdict="fail"
                    sample={
                      <span className="inline-block rounded-sm bg-fire-red px-2 py-1 font-ui text-xs font-bold text-pearl">
                        Revoke
                      </span>
                    }
                  />
                  <ContrastRow
                    pairing="Cloud White on status green"
                    ratio="1.41"
                    verdict="fail"
                    sample={
                      <span className="inline-block rounded-sm bg-status-instock px-2 py-1 font-ui text-xs font-bold text-cloud-white">
                        In stock
                      </span>
                    }
                  />
                </tbody>
              </table>
            </Card>

            {/* Keyboard focus across the three surface types it has to survive. */}
            <Card className="flex flex-col gap-5 p-6">
              <div>
                <p className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                  Keyboard focus
                </p>
                <p className="mt-1 max-w-2xl font-ui text-sm text-smoke-gray">
                  Tab through the three controls below. The ring is two layers —
                  a Signal Yellow halo outside a Dark Smoke contrast ring — so at
                  least one layer always separates from whatever is underneath.
                  A single yellow ring would disappear on the yellow control.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-5">
                <div className="flex flex-col items-center gap-2">
                  <Button variant="confirm">Signal Yellow</Button>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    dark layer carries it
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <Button variant="paper">Pearl / White</Button>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    both layers read
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <Button variant="outline">Dark Smoke</Button>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    yellow halo carries it
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 border-t border-ink-600 pt-5">
                <Badge variant="volt">In stock</Badge>
                <Badge variant="signal">Email verified</Badge>
                <p className="font-ui text-sm text-smoke-gray">
                  Two different jobs, two different colours: green means{' '}
                  <span className="font-data">available</span> and nothing else;
                  Signal Yellow carries focus, confirmation and emphasis.
                </p>
              </div>
            </Card>

            <div className="flex flex-col gap-2">
              <Rule>
                Ink text on every bright fill — Signal Yellow, Fire Red, status
                green, and the fire gradient. The accessible choice and the
                comic-book look are the same choice.
              </Rule>
              <Rule tone="deny">
                Pearl or Cloud White on any bright fill. Each pairing above
                lands between 1.30:1 and 3.20:1 and fails outright.
              </Rule>
              <Rule>
                Colour never carries meaning alone. Availability, status, and
                errors all pair their colour with a word, so they survive
                greyscale and colour-blindness.
              </Rule>
              <Rule>
                Permanent Marker never carries critical information on its own.
                Prices, potency, invite codes, and legal copy stay in Archivo or
                Space Mono.
              </Rule>
            </div>
          </Section>
          {/* ---- 9. Brand primitives ------------------------------------- */}
          <Section
            id="primitives"
            eyebrow="Section 09"
            title="Brand primitives"
            note="Reusable CloudMarket components, built in isolation. None of these is wired into a customer-facing page yet — this section is the only place they render."
          >
            <div className="flex flex-col gap-10">
              {/* Comic cloud system — rebuilt against the approved reference */}
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                    Comic cloud system
                  </h3>
                  <Badge variant="ember" tilt>
                    Phase A prototype
                  </Badge>
                </div>
                <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                  Rebuilt to match the owner-approved reference. A cloud is a
                  cluster of overlapping puffs of varying size — billowy across
                  the top, busier underneath — never an evenly scalloped
                  rectangle. Ink outline, halftone grain, ink runs and splatter
                  come from the same seeded geometry, so no two clouds repeat.
                </p>
                <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                  Content always sits in an ordinary rectangular box on its own
                  layer. The cloud is <span className="font-data">aria-hidden</span>{' '}
                  and <span className="font-data">pointer-events-none</span>.
                </p>

                <details className="panel-sm rounded-md bg-ink-800 p-4">
                  <summary className="cursor-pointer font-ui text-sm font-bold text-cloud-white">
                    Approved visual reference (for comparison)
                  </summary>
                  <div className="mt-4 flex flex-col gap-2">
                    <Image
                      src={artCloudFrameReference}
                      alt="Owner-approved CloudFrame visual reference"
                      sizes="(min-width: 1024px) 900px, 95vw"
                      className="h-auto w-full rounded-md"
                    />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      brand/reference/cloudmarket-cloudframe-approved.png
                    </p>
                  </div>
                </details>

                {/* A + B — product clouds, without and with a thumbnail */}
                <div className="grid gap-8 lg:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <CloudProductFrame
                      seed={3}
                      eyebrow="Sample · Demo data"
                      name="Sample Product A"
                      size="3.5g"
                      price="$00.00"
                    />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      A · no thumbnail · surface pearl
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <CloudProductFrame
                      seed={7}
                      eyebrow="Sample · Demo data"
                      name="Sample Product B"
                      size="7g"
                      price="$00.00"
                      image={{
                        src: artFaviconSource,
                        alt: 'Placeholder sample image — not real product photography',
                      }}
                    />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      B · prominent thumbnail · 80px mobile / 112px desktop, ink outline, hard shadow
                    </p>
                  </div>
                </div>

                {/* C — vendor accent glow */}
                <div className="grid gap-8 lg:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <CloudProductFrame
                      seed={11}
                      surface="cloud-white"
                      glowColor="var(--fire-red)"
                      eyebrow="Sample · Demo data"
                      name="Sample Product C"
                      size="3.5g"
                      price="$00.00"
                      badge={<Badge variant="flare">Demo badge</Badge>}
                    />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      C · glowColor Fire Red · tight bloom, not neon
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <CloudProductFrame
                      seed={13}
                      surface="cloud-white"
                      glowColor="var(--signal-yellow)"
                      eyebrow="Sample · Demo data"
                      name="Sample Product D"
                      size="14g"
                      price="$00.00"
                      image={{
                        src: artFaviconSource,
                        alt: 'Placeholder sample image — not real product photography',
                      }}
                    />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      D · glowColor Signal Yellow
                    </p>
                  </div>
                </div>

                {/* D — long title */}
                <div className="flex max-w-2xl flex-col gap-2">
                  <CloudProductFrame
                    seed={17}
                    eyebrow="Sample · Demo data"
                    name="A deliberately extremely long sample product name that must wrap cleanly across multiple lines"
                    size="28g"
                    price="$00.00"
                    image={{
                      src: artFaviconSource,
                      alt: 'Placeholder sample image — not real product photography',
                    }}
                  />
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    E · long title · the box grows downward, the cloud follows,
                    text never distorts
                  </p>
                </div>

                {/* E + F — wide multi-cloud banners */}
                <div className="flex flex-col gap-2 pt-4">
                  <h4 className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Wide banner — composed, not stretched
                  </h4>
                  <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                    A dominant central cloud carries the text; supporting clouds
                    drift behind it at varying sizes and offsets. Layer order is
                    explicit, so no decorative cloud edge can ever cross the
                    headline. Each box keeps a 5:3 aspect ratio matching its
                    viewBox, so the clouds scale uniformly and never smear.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <CloudClusterBanner seed={5} count={5}>
                    <GlowingHeadline as="p">
                      Private marketplace. Cloud 9 access only.
                    </GlowingHeadline>
                    <p className="mt-3 font-ui text-sm text-ink opacity-80">
                      Apply to shop, apply to vend, or redeem an invite code.
                    </p>
                  </CloudClusterBanner>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    F · multi-cloud banner, no glow · solid ink headline
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <CloudClusterBanner
                    seed={23}
                    count={4}
                    glowColor="var(--signal-yellow)"
                  >
                    <GlowingHeadline as="p" glowColor="var(--signal-yellow)">
                      Private marketplace. Cloud 9 access only.
                    </GlowingHeadline>
                    <p className="mt-3 font-ui text-sm text-ink opacity-80">
                      Body copy stays Archivo and never glows.
                    </p>
                  </CloudClusterBanner>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    G · Signal Yellow vendor banner · solid fill underneath the glow
                  </p>
                </div>

                {/* G + H — demo vendor accents */}
                <div className="flex flex-col gap-2">
                  <CloudClusterBanner seed={41} count={4} glowColor="#4aa8ff">
                    <GlowingHeadline as="p" glowColor="#4aa8ff">
                      Demo Vendor — Blue Accent
                    </GlowingHeadline>
                    <p className="mt-3 font-ui text-sm text-ink opacity-80">
                      Sample vendor storefront banner. Accent is presentational
                      only — nothing is persisted.
                    </p>
                  </CloudClusterBanner>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    H · blue vendor banner · glowColor #4aa8ff
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <CloudClusterBanner seed={59} count={4} glowColor="#b06cff">
                    <GlowingHeadline as="p" glowColor="#b06cff">
                      Demo Vendor — Purple Accent
                    </GlowingHeadline>
                    <p className="mt-3 font-ui text-sm text-ink opacity-80">
                      The CloudMarket platform palette is unchanged; only the
                      bloom, headline glow and spark marks take the accent.
                    </p>
                  </CloudClusterBanner>
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    I · purple vendor banner · glowColor #b06cff
                  </p>
                </div>

                {/* I — compact / status */}
                <div className="flex flex-col gap-2 pt-4">
                  <h4 className="font-poster text-lg tracking-tight text-cloud-white uppercase">
                    Compact / status treatment
                  </h4>
                </div>
                <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                  <CloudProductFrame seed={29} name="Watchlist" data="4 items tracked" />
                  <CloudProductFrame
                    seed={31}
                    name="Under review"
                    data="Application submitted"
                  />
                  <CloudProductFrame
                    seed={37}
                    surface="cloud-white"
                    glowColor="var(--signal-yellow)"
                    name="Approved"
                    data="Marketplace access active"
                  />
                </div>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  J · compact clouds · status is carried by the words, never by
                  the glow alone
                </p>

                <div className="flex flex-col gap-2 pt-2">
                  <Rule>
                    glowColor is presentational only. It drives the outer bloom,
                    the headline text-shadow and the spark marks — never the
                    cloud body, the ink outline, or body copy. Nothing is
                    persisted and no schema changed.
                  </Rule>
                  <Rule tone="deny">
                    Letting the accent carry meaning. Every status above states
                    itself in words, so it survives greyscale, forced colours,
                    and a stripped text-shadow.
                  </Rule>
                </div>
              </div>

              {/* FireAccent */}
              <div className="flex flex-col gap-4 border-t border-ink-600 pt-8">
                <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                  FireAccent
                </h3>
                <Card className="flex flex-wrap items-end gap-10 p-8">
                  <div className="flex flex-col items-center gap-2">
                    <FireAccent size="sm" />
                    <p className="font-data text-[0.625rem] text-smoke-gray">sm</p>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <FireAccent size="md" />
                    <p className="font-data text-[0.625rem] text-smoke-gray">md</p>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <FireAccent size="lg" />
                    <p className="font-data text-[0.625rem] text-smoke-gray">lg</p>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <FireAccent size="lg" animated id="cloudmarket-fire-demo" />
                    <p className="font-data text-[0.625rem] text-signal-yellow">
                      animated · 900ms
                    </p>
                  </div>
                </Card>
                <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                  Signal Yellow at the tip, Ember through the middle, Fire Red at
                  the base. Ember appears here and nowhere else in the brand.
                </p>
              </div>

              {/* Artwork wrappers */}
              <div className="flex flex-col gap-4 border-t border-ink-600 pt-8">
                <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                  Artwork wrappers
                </h3>

                <div className="grid gap-3 lg:grid-cols-2">
                  <Card className="flex flex-col items-center justify-center gap-4 p-8">
                    <CloudMarketWordmark size="lg" />
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      CloudMarketWordmark · needs a dark plate
                    </p>
                  </Card>

                  <Card className="flex flex-col items-center justify-center gap-4 p-8">
                    <div className="w-56">
                      <CloudMarketMascot variant="primary" decorative />
                    </div>
                    <p className="font-data text-[0.625rem] text-smoke-gray">
                      CloudMarketMascot primary · decorative
                    </p>
                  </Card>
                </div>

                <Card className="flex flex-col gap-4 p-6">
                  <CloudMarketMascot
                    variant="header"
                    alt="The CloudMarket mascot pushing a cart of products through the clouds"
                  />
                  <p className="font-data text-[0.625rem] text-smoke-gray">
                    header variant with real alt text — announced, because here it
                    carries the meaning
                  </p>
                </Card>
              </div>

              {/* HeaderCloudFireStrip */}
              <div className="flex flex-col gap-4 border-t border-ink-600 pt-8">
                <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                  HeaderCloudFireStrip
                </h3>
                <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                  The artwork masses smoke and fire at the left and right and
                  leaves the centre empty, so navigation sits in the gap. The band
                  below carries real links — tab through them to confirm the strip
                  intercepts nothing.
                </p>

                <div className="panel relative isolate flex h-20 items-center justify-between overflow-hidden rounded-lg bg-dark-smoke px-5">
                  <HeaderCloudFireStrip intensity="ambient" />
                  <span className="font-brand text-xl text-cloud-white">
                    CloudMarket
                  </span>
                  <nav aria-label="Cloud fire strip demo">
                    <ul className="flex gap-4 font-ui text-sm font-semibold text-cloud-white">
                      <li>
                        <a
                          href="#primitives"
                          className="rounded-sm hover:text-signal-yellow"
                        >
                          Market
                        </a>
                      </li>
                      <li>
                        <a
                          href="#primitives"
                          className="rounded-sm hover:text-signal-yellow"
                        >
                          Vendors
                        </a>
                      </li>
                    </ul>
                  </nav>
                </div>
                <p className="font-data text-[0.625rem] text-smoke-gray">
                  ambient · the readable default under text
                </p>

                <div className="panel relative isolate flex h-20 items-center overflow-hidden rounded-lg bg-dark-smoke px-5">
                  <HeaderCloudFireStrip intensity="full" />
                  <span className="font-data text-xs text-cloud-white">
                    full — reserve for bands with no text over the busy edges
                  </span>
                </div>
              </div>

              {/* LoadingCloud */}
              <div className="flex flex-col gap-4 border-t border-ink-600 pt-8">
                <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                  LoadingCloud
                </h3>
                <Card className="flex flex-wrap items-end gap-10 p-8">
                  <div className="flex flex-col items-center gap-2">
                    <LoadingCloud size="sm" decorative />
                    <p className="font-data text-[0.625rem] text-smoke-gray">sm</p>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <LoadingCloud size="md" decorative />
                    <p className="font-data text-[0.625rem] text-smoke-gray">md</p>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <LoadingCloud size="lg" label="Loading the market" />
                    <p className="font-data text-[0.625rem] text-signal-yellow">
                      lg · role status
                    </p>
                  </div>
                </Card>
                <p className="max-w-2xl font-ui text-sm text-smoke-gray">
                  The two small clouds are decorative and invisible to a screen
                  reader. The large one announces &ldquo;Loading the
                  market&rdquo; through a status region, without stealing focus.
                </p>
              </div>

              {/* Reduced motion */}
              <div className="flex flex-col gap-3 border-t border-ink-600 pt-8">
                <h3 className="font-poster text-xl tracking-tight text-cloud-white uppercase">
                  Reduced motion
                </h3>
                <Rule>
                  Every animated primitive above resolves to a complete, still
                  composition when reduced motion is on. The flame stays fully
                  drawn and lit; the loading cloud keeps its smoke at a resting
                  opacity rather than emptying out. Nothing is removed and
                  nothing races to an end frame.
                </Rule>
                <Rule tone="deny">
                  Infinite motion a reduced-motion visitor cannot escape.
                  Keyframes live inside{' '}
                  <span className="font-data">
                    prefers-reduced-motion: no-preference
                  </span>
                  , so they are never declared for those users at all.
                </Rule>
                <Rule>
                  Decorative art is aria-hidden and pointer-events-none;
                  meaningful art takes real alt text. No primitive relies on
                  shape or colour alone to communicate.
                </Rule>
              </div>
            </div>
          </Section>
        </div>

        <footer className="mt-20 border-t-2 border-ink pt-6">
          <p className="font-data text-xs text-smoke-gray">
            CloudMarket Phase A design reference · internal · noindexed · no
            production route or component was changed to build this page.
          </p>
        </footer>
      </main>
    </>
  )
}
