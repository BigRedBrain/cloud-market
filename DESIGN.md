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

Measured, from the compiled stylesheet:

| Pairing | Ratio | AA text |
| --- | --- | --- |
| cream on ink-900 (body) | **16.27** | ✅ |
| cream on ink-800 (panel) | **14.75** | ✅ |
| cream on ink-700 (input) | **12.81** | ✅ |
| smoke on ink-900 (secondary) | **5.90** | ✅ |
| smoke on ink-800 | **5.35** | ✅ |
| ink on volt (primary button) | **14.61** | ✅ |
| ink on ember (accent) | **8.23** | ✅ |
| ink on flare (destructive) | **5.50** | ✅ |
| ink on cream (paper panel) | **17.52** | ✅ |
| volt focus ring on ink-900 | **13.56** | ✅ |
| flare error text on ink-800 | **4.63** | ✅ |
| ~~cream on flare~~ | 3.18 | ❌ never |
| ~~cream on volt~~ | 1.20 | ❌ never |

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
| `--cream` | `#f2ece0` | Primary text on dark, paper panels |
| `--smoke` | `#8c8f94` | Secondary text, disabled, halftone tint |
| `--volt` | `#3ff873` | Primary action, focus ring, success |
| `--ember` | `#ff8031` | Accent, heat, warnings, promo |
| `--flare` | `#f93635` | Destructive, urgency, errors |

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

- Variants: `primary` (volt), `accent` (ember), `destructive` (flare), `paper`
  (cream), `outline`, `ghost`.
- Sizes: `sm` 36px, `md` **44px — the default**, `lg` 52px, `icon` 44px.
  Default is 44px because most of this storefront is used one-handed on a phone.
- Disabled loses the shadow entirely, so it never looks pressable.
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

## 7. Motion

Motion is used in three places only: the button press, the card lift, and the
cloud's smoke. Everything else is static by choice.

`prefers-reduced-motion` is honoured twice over — a global CSS reset in
`globals.css` neutralises transitions and animations, and the cloud button reads
the same preference through Framer Motion's `useReducedMotion()` to settle its
smoke into a static haze.

What **survives** reduced motion, deliberately: the fire glow, the focus ring,
and the pressed state. Those communicate state rather than decorate, and
removing them would cost information.

---

## 8. Performance

- No `feTurbulence`. Noise filters rasterise expensively across large areas and
  are the first thing to stutter on a mid-range Android — the device most of
  this storefront's traffic arrives on. Both textures are pure CSS gradients,
  which composite for free.
- Hard shadows are cheaper than blurred ones.
- The only filter in the system is a `drop-shadow` on a single small element,
  applied on hover.
- Three font families is the ceiling. All subset to latin with `display: swap`.
