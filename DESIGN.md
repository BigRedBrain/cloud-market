# Cloud Market — design system

Urban hip-hop flyer meets comic-book panel. Charcoal foundation, thick ink
outlines, hard zero-blur offset shadows, halftone shading.

The grit is **structural** — outlines, panels, stickers, stamps — rather than
filter-based. That is what keeps it premium instead of novelty, and it is also
why it renders fast: there is not a single blur, noise filter, or backdrop
effect doing heavy work anywhere in the system.

Live reference: **`/design`** (noindexed).

---

## 1. The one rule

> **Every bright fill takes ink text, never cream.**

Volt, ember, and flare are saturated mid-tones. Cream on them lands between
1.2:1 and 3.2:1 and fails outright. Ink on the same fills clears 5.5:1. It is
also the correct comic-book look — dark line-art on bright colour — so the
accessible choice and the aesthetic choice are the same choice, and the system
does not have to trade one against the other.

Measured from the compiled stylesheet. **16 pairings, 0 failures.** Hover states
are measured too — a button must not become unreadable at the moment it is
about to be clicked.

| Pairing | Ratio | AA text |
| --- | --- | --- |
| white on ink-900 (body) | **19.14** | ✅ |
| white on ink-800 (panel) | **17.35** | ✅ |
| white on ink-700 (input) | **15.07** | ✅ |
| ink on cream (paper panel) | **17.52** | ✅ |
| ink on volt (confirm) | **14.61** | ✅ |
| volt in-stock text on panel | **12.30** | ✅ |
| ink on volt hover | **9.40** | ✅ |
| ink on ember (**primary**) | **8.23** | ✅ |
| ember low-stock text on panel | **6.93** | ✅ |
| smoke secondary on page | **5.90** | ✅ |
| ink on ember hover | **5.75** | ✅ |
| ink on flare (destructive) | **5.50** | ✅ |
| smoke secondary on panel | **5.35** | ✅ |
| ink on flare hover | **4.90** | ✅ |
| flare error text on panel | **4.63** | ✅ |
| volt focus ring on page | **13.56** | ✅ |
| ~~cream on flare~~ | 3.18 | ❌ never |
| ~~cream on volt~~ | 1.20 | ❌ never |

`--flare-deep` is pinned at lightness 0.612 rather than the 0.556 that *looks*
like a natural darker hover, because ink on 0.556 measures 3.94:1 and fails.
The token carries a comment saying so, to stop it being "corrected" later.

---

## 2. Colour tokens

Authored in oklch so lightness is perceptually uniform — adjusting L keeps hue
and chroma stable, so a tint stays on-brand rather than drifting. Lightning CSS
emits hex fallbacks plus `lab()` for wide-gamut displays automatically.

| Token | Compiled | Role |
| --- | --- | --- |
| `--ink-950` | `#030304` | Outlines, hard shadows, text on bright fills |
| `--ink-900` | `#0f0f12` | Page foundation |
| `--ink-800` | `#1a1a1e` | Panel surface |
| `--ink-700` | `#26262a` | Raised surface, inputs |
| `--ink-600` | — | Hairlines on dark |
| `--white` | `#ffffff` | **High-contrast text** on dark |
| `--cream` | `#f2ece0` | **Surfaces** — paper panels, not body text |
| `--smoke` | `#8c8f94` | Secondary text, disabled, halftone tint |
| `--ember` | `#ff8031` | **Primary action**, heat, low stock |
| `--flare` | `#f93635` | Destructive, urgency, errors |
| `--volt` | `#3ff873` | **Selective only** — see below |

**White and cream do different jobs.** White is a text colour; cream is a
surface colour. Keeping them separate is what stops the dark UI drifting into a
muddy sepia — cream body text on charcoal reads as aged paper, which fights the
"premium" half of the brief.

**Electric green is rationed.** Volt appears only where it means something: in
stock, success, confirm, and the focus ring. It is never decoration. Used for
ordinary actions it would stop reading as a signal — and "in stock" is the most
commercially important signal on a product card, so it gets the loudest colour
in the palette and nothing else competes for it.

Semantic aliases (`--primary`, `--destructive`, `--muted`…) map onto these, so
shadcn components drop in unmodified. Brand names are also addressable directly
(`bg-volt`, `text-ember`) for cases the semantic layer would obscure.

**Paper panels.** `[data-surface="paper"]` flips the whole token scope to cream.
This is a structural device, not a theme toggle: it marks content lifted out of
the dark world — receipts, order summaries, legal copy. Use `<Card
surface="paper">`.

There is no light theme. The brand is dark-first, so `:root` *is* the charcoal
theme rather than a variant of a light one.

---

## 3. Typography

Three faces, three jobs, no overlap.

| Face | Role | Rules |
| --- | --- | --- |
| **Anton** | Display | Never below 1.5rem. Never for prose. Uppercase, tight tracking. One weight — which forces headlines to stay short and loud. |
| **Archivo** | Body | Everything readable. Variable weight, large x-height, holds up at 14–16px on a phone at night. |
| **Space Mono** | Data | Prices, THC %, weights, order and licence numbers. Fixed advance widths stop totals jittering as they update. |

`font-variant-numeric: tabular-nums` is set globally on `body` so price columns
align optically without per-component effort.

Scale: display steps at `text-5xl` → `text-8xl` for heroes, `text-3xl` for
section heads, `text-lg`/`text-xl` for card titles. Body sits at `text-base`
(16px) — never smaller for prose. `text-sm` for secondary, `text-xs`/
`text-[0.6875rem]` for mono eyebrows only.

---

## 4. Logo placement rules

Component: `<Logo variant tone />` — `full` (lockup), `mark` (cloud only),
`stacked`.

- **Clear space** — a margin equal to the mark's cap-height on all four sides.
  Built into `full` and `stacked` as padding, so correct placement is the
  default rather than something to remember.
- **Minimum size** — 24px for the mark, 96px wide for the lockup. Below that the
  2px outline closes up and the lobes read as a blob.
- **Tone is binary** — `cream` on dark surfaces, `ink` on cream paper panels and
  on volt/ember fills. There is no third option: the outline needs a decisive
  value contrast, and a mid-tone background gives it neither.
- **Never** rotate the mark, fill it with a gradient, add a drop shadow, place it
  on a photograph without a solid plate behind it, or recolour it outside the
  two tones.
- The mark is the same silhouette as the cloud button. One shape, every scale —
  that repetition is what makes it read as a brand rather than an icon.

---

## 5. Components

### Buttons

The press is physical: 1px lift on hover, then on `:active` the control travels
2px down-right while the ink shadow collapses from 3px to 1px. Total travel is
2px — enough to feel like a stamp hitting paper, never enough to cause a
mis-tap.

- Variants: `primary` (**ember** — the default call to action), `destructive`
  (flare), `volt` (**confirm/success only**), `paper` (cream), `outline`,
  `ghost`.
- Sizes: `sm` 36px, `md` **44px — the default**, `lg` 52px, `icon` 44px.
  Default is 44px because most of this storefront is used one-handed on a phone.
- Disabled loses the shadow entirely, so it never looks pressable.
- **The ember glow fires on `primary` only** — see the animation policy in §7.
  Press physics apply to every variant, because that is feedback rather than
  decoration.
- No `asChild` — Radix Slot is not a dependency. For links, spread
  `buttonVariants({ variant, size })` onto an anchor.

### The cloud button

The signature. A cloud silhouette that smoulders — smoke drifts inside the
shape, the outer edge ignites on hover **and on keyboard focus**.

- The glow is a CSS `drop-shadow` filter, not `box-shadow`: drop-shadow follows
  the alpha channel, so the fire hugs the lobed edge instead of a rectangle.
  It is GPU-composited, so igniting costs no layout or paint.
- The SVG uses `preserveAspectRatio="none"` so the button sizes to its label.
  The path carries `vector-effect="non-scaling-stroke"`, so the ink stays a
  constant 2px however the shape stretches.
- Only the smoke uses Framer Motion. Lift and press are plain CSS.
- Use it for the primary conversion action on a view — shop, add to bag, place
  order. **One per screen.** It is the loud thing; a second one makes neither
  loud.

### Forms

Checkout is where visual ambition does the most damage, so the rules are
conservative:

- 44px minimum height. Inputs sit on a raised ink surface, never transparent —
  borderless "minimal" fields are the most common way to make a form ambiguous
  on a phone in poor light.
- Labels are never placeholders. Placeholder-as-label fails the moment someone
  types, and fails permanently for screen readers.
- **Errors signal twice**: flare border *plus* a 6px left rule, so the state is
  never colour-only. The message carries `role="alert"`.
- `<Field>` wires `aria-describedby`, `aria-invalid`, and required-state
  announcement automatically via a render prop, so the relationships cannot be
  forgotten at the call site.

### Product cards

Fixed hierarchy: image → strain type → name → potency → price → action. Price is
Space Mono at display weight because it is the most-scanned value on the card.

- **One badge maximum.** The component takes a single `badge` prop rather than a
  list, which makes the rule impossible to break by accident.
- The card is not wrapped in an anchor. The title carries the link and stretches
  its hit area with `after:absolute`, leaving "Add to bag" a genuine sibling —
  a card-wide anchor with a nested button is a nesting violation and makes the
  button unreachable by keyboard.
- Sold-out state greys the image, stamps it, and swaps the action to "Notify me"
  rather than disabling into a dead end.

### Navigation

Sticky, because the bag total is the most-checked value and should never need a
scroll. A heavy bottom ink rule instead of a shadow — on charcoal a soft shadow
is invisible.

The mobile menu is a **disclosure, not a modal**: no focus trap, no scroll lock,
which keeps it predictable with a screen reader and avoids iOS scroll-locking
bugs. Escape closes it and returns focus to the trigger.

Bag count is text inside the badge, never a bare coloured dot — a count that
exists only as colour tells a colour-blind shopper nothing.

### Badges

Die-cut stickers. Loud, therefore rationed. `tilt` rotates 2° and is **off by
default**: rotation is for a single hero sticker, and a grid of tilted badges
reads as a mistake rather than a style. Every variant pairs colour with text so
it survives greyscale.

### Empty states

An empty screen is an invitation to act, so each takes exactly one action.

- Say what is here, not what is missing — "Nothing in your bag yet", not "Empty
  cart".
- The action names its destination — "Browse flower", not "Continue".
- No apology. An empty bag is not an error and must not read like one.

### Loading states

Skeletons keep the ink outline of what they replace and mirror its exact
geometry, so nothing shifts when content lands. Layout shift on a catalogue grid
is both a ranking penalty and a genuine mis-tap hazard.

`<Spinner>` carries `role="status"` and an SR-only label, so a screen reader
user learns an order is being placed without focus being stolen.

---

## 6. Responsive

Mobile-first throughout; the default column count is always 1.

| Breakpoint | Catalogue grid | Navigation |
| --- | --- | --- |
| `< 640px` | 1 column | Disclosure menu |
| `sm` 640px | 2 columns | Disclosure menu |
| `md` 768px | 2 columns | Inline links |
| `lg` 1024px+ | 3 columns | Inline links |

Content max-width is `max-w-7xl` with `px-4` / `sm:px-6` gutters. Hero display
type steps from `text-6xl` to `text-8xl` at `sm`.

---

## 7. Motion and reduced-motion alternatives

**All motion in the system is CSS.** No JavaScript animation runtime ships.

### Animation policy — where motion is allowed

Decorative motion is confined to four surfaces. This is a whitelist: anything
not on it does not get ambient or decorative animation, and **no visual effect
is ever added globally**.

| Allowed | What runs there |
| --- | --- |
| **Hero** | Ambient smoke (3 drifting layers) |
| **Logo** | Burning-cloud entrance — inks on, catches fire |
| **Primary CTAs** | Cloud button smoke + hover flames; ember glow on `variant="primary"` |
| **Success screens** | One-shot settle + single ember ring, ~700ms |

Everything else — **shop, cart, checkout, account, admin** — stays calm. Those
are task surfaces where usability beats atmosphere, and a grid of animated
controls actively hurts scanning.

Two things are *not* decoration and therefore apply everywhere, deliberately:

- **Press physics.** The 1px lift and 2px press are interaction feedback. A
  button that does not respond to touch feels broken.
- **Focus rings.** Non-negotiable on every surface.

The ember glow is scoped to `variant="primary"` only. It previously fired on
every elevated button, which meant "Cancel" and "Keep browsing" glowed as hard
as "Place order" — so nothing did. Restricting it restores the signal.

Error and warning panels are completely static. Motion on a failure reads as
the interface being pleased with itself.

### Reduced motion is an alternative, not a removal

Every keyframe in the system is declared **inside** a
`@media (prefers-reduced-motion: no-preference)` block, and every element's
resting CSS is its *finished* state. The consequence is that a reduced-motion
visitor gets the complete composition immediately — the burning cloud is fully
lit and flaming, the smoke haze is present, the glow works — it simply holds
still. Nothing is missing, nothing races to an end frame.

That is a deliberate improvement over the usual approach of neutralising
durations globally, which leaves animations snapping to their last keyframe and
can leave draw-on effects half-rendered.

| Effect | Full motion | Reduced motion |
| --- | --- | --- |
| Ambient smoke | 3 layers drifting, 37/43/53s | Static haze, same composition |
| Burning cloud | Inks on, flames grow, vents light | Fully lit, immediately |
| Cloud button smoke | 4 puffs rising | Static puff at 12% opacity |
| Cloud button flames | Flicker on hover | Appear on hover, no flicker |
| Success screen | Mark settles, ring expands once | Mark static, ring hidden |
| Button press | 1px lift, 2px press | Instant, glow still fires |
| Ember glow | Fades in over 150ms | **Kept** — communicates state |
| Focus ring | Always instant | **Kept** — non-negotiable |

The global reset in `globals.css` remains as a backstop for any transition added
later without thought.

### Checkout runs quieter

`/checkout` has no smoke, no cloud button, no hover lift on the summary, and a
stripped header. The brand keeps its ink outlines, panels, and type; the
theatrics stop at the payment step.

---

## 8. Performance audit

Measured against the production build (`next build` + `next start`), real
transferred bytes, gzipped.

| Route | HTML | CSS | JS | Total |
| --- | --- | --- | --- | --- |
| `/` | 11.4 KB | 9.6 KB | 199.5 KB | **220.3 KB** |
| `/design` | 21.3 KB | 9.6 KB | 199.5 KB | **230.2 KB** |
| `/checkout` | 5.7 KB | 9.6 KB | 185.9 KB | **201.0 KB** |

### The one change the audit forced

The first measurement put the homepage at **239.0 KB gzip of JS**. Framer Motion
accounted for ~39.5 KB of it — to animate four ellipses and one draw-on.

Both were rewritten as CSS keyframes. Framer Motion is now imported nowhere, and
`SmokeBackground`, `CloudButton`, and `BurningCloud` are all **server components
shipping zero client JavaScript**:

| | Before | After |
| --- | --- | --- |
| Homepage JS (gzip) | 239.0 KB | **199.5 KB** |
| Homepage total (gzip) | 258.4 KB | **220.3 KB** |

`motion` remains in `package.json` for orchestrated route/panel transitions
later, where CSS genuinely cannot do the job. It must not return to the
homepage's critical path without a measurement justifying it.

### Where the remaining bytes go

~186 KB gzip is the Next 16 + React 19 App Router baseline — `/checkout` pays it
too, and it carries almost no brand code. The visual system's **marginal** cost
over that baseline is ~13.6 KB, nearly all of it lucide icons and the one client
component in the app.

**The entire design system's CSS is 9.6 KB gzip.**

### Standing rules

- **One client component**: `SiteNav`, for the mobile menu's open state. Every
  other component in the system is RSC.
- **No `feTurbulence`.** Noise filters rasterise expensively over large areas and
  are the first thing to stutter on a mid-range Android — the device most of
  this storefront's traffic arrives on. Every texture is a CSS gradient.
- **No `filter: blur()` on large elements.** Smoke softness comes from the
  gradients themselves. The only filter in the system is a `drop-shadow` on one
  small element, on hover.
- **Transform and opacity only** in animation. Nothing animated triggers layout
  or paint.
- **Hard shadows are cheaper than blurred ones**, which is convenient, because
  they are also the look.
- **Images** carry explicit `width`/`height`, `loading="lazy"`, and
  `decoding="async"`. next/image lands in Phase 3 with real Blob URLs.
- **Three font families is the ceiling**, all latin-subset with `display: swap`.
