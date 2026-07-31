# CMS & Marketing Engine (Phase 2.5)

The business owner's control centre. Everything changed regularly — promotions,
homepage content, badges, announcements — stops being code.

Consumes the frozen design system unchanged. No component redesigned, no
animation altered, no design file touched.

---

## 1. Architecture review

### One idea carries most of the design: the publishing window

Every editable record shares four columns — `status`, `publish_at`,
`unpublish_at`, `priority`. **Whether something is live is computed at read
time**, never stored as a flag something has to flip:

```sql
(status = 'published' or (status = 'scheduled' and publish_at <= now()))
and (publish_at   is null or publish_at   <= now())
and (unpublish_at is null or unpublish_at >  now())
and deleted_at is null
```

That single predicate is why **"publish automatically" needs no cron, no queue
and no background worker**. A campaign scheduled for Friday 9am simply starts
matching the query at 9am and stops matching when its window closes. There is no
second source of truth, so nothing can get stuck half-published.

`now()` is evaluated by **Postgres**, not Node, so scheduling stays correct even
if an application server's clock drifts.

The predicate lives in exactly one exported function, `livePredicate()`. A
second, slightly different copy is precisely how a campaign ends up visible on
the homepage and invisible on a collection page.

### The piece that makes scheduling actually work

Computing liveness at read time is necessary but **not sufficient**. A statically
prerendered page is rendered once at build and never again, so a scheduled
campaign would never appear — nothing re-renders the page when the clock passes.

This was caught in testing: publishing an announcement changed nothing on a
static homepage.

The fix is `export const revalidate = 60` on the root layout. Admin edits are
still instant because every action calls `revalidatePath`; the window only
bounds *time-based* transitions, which land within a minute. Shorter would cost
cache hits for precision nobody needs on a storefront banner.

### Three layers, three visibilities

| Layer | File | Sees |
| --- | --- | --- |
| Public | `lib/cms/queries.ts` | Only what is live *right now* |
| Admin reads | `lib/cms/admin-queries.ts` | Everything, plus a derived `liveNow` |
| Admin writes | `lib/cms/actions.ts` | Everything, behind `requireAdmin()` |

Separate modules rather than one module with a flag — the same rule the catalog
follows, for the same reason: a flag is how unpublished content eventually
reaches a customer.

Admin reads are plain async functions, **not** Server Actions. A `'use server'`
export is a publicly callable endpoint.

### No visual change, and why that is true

The brief required no redesign and no homepage visual changes. Two mechanisms
enforce it:

1. **Fallbacks.** The hero reads a live campaign, and with none configured
   renders exactly the words it rendered before. Layout, type and motion are
   untouched; only the *source* of the text moved.
2. **Absence, not emptiness.** The announcement bar renders `null` when nothing
   is live — new chrome is absent rather than present-but-empty.
3. **Seed data is all `draft`.** Seeding published content would have silently
   rewritten the homepage.

Badge colours are constrained to the design system's existing Badge variants, so
an editor picks from the established visual language rather than introducing a
new colour.

### Server Components first

The whole storefront side is Server Components — the announcement bar included,
which ships **zero client JavaScript**. Client Components appear only in admin
forms, which genuinely need form state.

Membership toggles (products in a collection, badges on a product) are one tiny
form per item rather than a multi-select, so each toggle is an independent
action that works without JavaScript and cannot lose the rest of the selection
if one write fails.

---

## 2. Schema

```
media ──┬── campaigns ──┐
        │               ├── homepage_sections
        ├── collections ┘        │
        │        └── collection_products ──> products
        ├── brand_assets
        └── (products, via product_media)

badges ── product_badges ──> products
```

### Tables

| Table | Purpose |
| --- | --- |
| `campaigns` | Heroes, promotions **and the announcement bar** |
| `collections` + `collection_products` | Editorial groupings; a product can be in many |
| `badges` + `product_badges` | Reusable labels, assigned to products |
| `homepage_sections` | One row per homepage slot, ordered and scheduled |
| `brand_assets` | Named slots pointing at media — Brand Studio scaffolding |

### Decisions worth defending

**The announcement bar is a campaign, not its own table.** It has exactly the
same shape — message, call to action, schedule, priority. A second table would
have meant a second scheduling implementation to keep in step, and they *will*
drift.

**Collections are not categories.** A category is what a product *is* —
taxonomy, one per product, structural. A collection is a merchandising choice.
Keeping them separate stops editorial decisions corrupting the taxonomy.

**Badges are records, not booleans.** `products.featured` and `new_arrival` were
booleans, and that is the pattern this replaces: every new label would have meant
a migration and a deploy. A badge is a row, so the owner invents "Big Red Select"
unaided.

**`homepage_sections.config` is jsonb, but foreign keys are real columns.**
Per-type knobs differ genuinely and are editorial; anything that must point at
something real (`campaign_id`, `collection_id`) gets a column so the database can
enforce it.

**Media gained focal point, archive and replacement lineage.** `focal_x/focal_y`
are art direction, not decoration — the same photograph is cropped to a wide hero
and a 4:3 card, and without a focal point the subject drifts out of frame at one
of them. "Replace" **inserts a new row** and retires the old one rather than
mutating a URL, so what a campaign showed last month stays resolvable and a bad
replacement can be undone.

**Audit rows are not foreign-keyed to their entity.** `entity_type` and
`entity_id` are plain columns, because the log has to outlive the row it
describes — an archived campaign must not take its own history with it.

### Future compatibility

Not implemented; nothing blocks them:

| Feature | Path |
| --- | --- |
| A/B testing | Several campaigns already compete for one slot by `priority`. An `experiment_key` + bucket column turns "highest priority wins" into "assigned variant wins" without touching the resolver's shape. |
| Multiple storefront themes | Themes select *which* sections resolve. A nullable `theme_key` on `homepage_sections` filters the existing query. |
| Multi-store campaigns | Nullable `store_id` on `campaigns` and `homepage_sections`, pointing at the existing `stores` table; the predicate gains `store_id is null or store_id = :current`. |
| Scheduled seasonal branding | **Already possible.** `brand_assets` allows several rows per `key` with different windows — `resolveBrandAsset('homepage_hero')` returns whichever is live. |
| Personalised homepage | Sections resolve per request; adding an audience predicate is additive. |

---

## 3. Performance review

- **The announcement bar is one indexed query**, and `null` short-circuits the
  render entirely when nothing is live.
- **Badges load in one query per page**, keyed by product id — no N+1. Cards show
  the top badge; the data layer returns all of them because the product page
  shows more.
- **Indexes** target the resolver's hot paths:
  `campaigns (type, status, priority)` · `campaigns (publish_at, unpublish_at)` ·
  `collections (status, priority)` · `homepage_sections (sort_order)` ·
  `audit_log (entity_type, entity_id)`.
- **ISR at 60s** keeps the homepage static and cacheable while still honouring
  time-based publishing. Admin edits bypass it via `revalidatePath`.
- **`adminListMedia` is capped at 200 rows.** A media library grows without
  bound; pagination is the next step and the cap makes the limit explicit rather
  than letting the page quietly get slower.

### Known limits, stated honestly

- Collection and badge admin pages issue one membership query per row. Fine at
  seed scale (4 collections, 12 products); at hundreds it becomes an N+1 and
  should be folded into a single grouped query. Called out rather than
  pre-optimised.
- There is no upload transport yet — assets are added by URL. The record, alt
  text, focal point, archive and replace lineage all work; only the transport is
  pending Vercel Blob.

---

## 4. Accessibility review

Inherits the frozen system's guarantees and adds:

- **The announcement bar is a labelled landmark** (`role="region"`,
  `aria-label="Site announcement"`), so it can be found or skipped rather than
  being an unexplained strip of text before the nav.
- **Ember fill takes ink text**, per the contrast contract that every bright fill
  takes ink text. No new colour pairing was introduced.
- **Membership toggles carry `aria-pressed`**, so a screen reader announces
  "Staff Picks, pressed" rather than a bare button.
- **Every field has a visible `<label>`**; scheduling inputs use native
  `datetime-local`, which brings keyboard and screen-reader support for free.
- **Status is text, never colour alone** — "Live now", "Scheduled", "Draft" are
  words in a Badge, legible in greyscale.
- **Alt text is a required field** on media, defaulting to empty string so
  "decorative" is a deliberate choice rather than an omission.
- Admin forms work with **JavaScript disabled**.

---

## 5. Migration summary

**`0004_true_amazoness.sql`** — additive only. Zero `DROP TABLE`, `TRUNCATE`,
`DELETE` or `DROP COLUMN`.

| | |
| --- | --- |
| New enums | `content_status`, `campaign_type`, `homepage_section_type`, `brand_asset_type` |
| New tables | `campaigns`, `collections`, `collection_products`, `badges`, `product_badges`, `homepage_sections`, `brand_assets` |
| Altered | `media` (+`title`, `focal_x`, `focal_y`, `archived_at`, `replaced_by_media_id`) · `audit_log` (+`entity_type`, `entity_id`, `summary`) · `audit_event` enum (+18 CMS values) |
| Existing data | untouched — every added column is nullable or defaulted |

Applied to **development only**. Production has 0000–0003.

```bash
npm run db:migrate
npm run db:seed:cms
```

Seed: 6 badges, 4 collections, 3 campaigns, 5 homepage sections, 23 collection
memberships, 6 badge assignments — **all publishable records as `draft`**.

### Audit events added

`CAMPAIGN_CREATED` · `CAMPAIGN_UPDATED` · `CAMPAIGN_PUBLISHED` ·
`CAMPAIGN_ARCHIVED` · `COLLECTION_CREATED` · `COLLECTION_UPDATED` ·
`COLLECTION_PUBLISHED` · `BADGE_CREATED` · `BADGE_UPDATED` · `PRODUCT_FEATURED` ·
`PRODUCT_BADGED` · `HERO_UPDATED` · `HOMEPAGE_SECTION_UPDATED` ·
`HOMEPAGE_SECTION_PUBLISHED` · `ANNOUNCEMENT_PUBLISHED` · `MEDIA_UPLOADED` ·
`MEDIA_REPLACED` · `MEDIA_ARCHIVED` · `BRAND_ASSET_UPDATED`

Every publish writes one, with `entity_type`, `entity_id` and a readable summary
("weekend_sale \"Weekend Sale\" → published"). Audit writes never throw — losing
a log line must not stop an owner launching a promotion.

---

## 6. Verified

| Check | Result |
| --- | --- |
| All-draft seed leaves storefront unchanged | ✅ no announcement bar, hero fallback intact |
| Publishing an announcement makes it appear | ✅ bar, message and CTA all render |
| Scheduling it forward makes it disappear | ✅ |
| Hero falls back with no live campaign | ✅ |
| Admin CMS routes without a session | ✅ 307 × 5 |
| Admin CMS routes with a forged cookie | ✅ 0 admin content rendered |
| build / lint / typecheck | ✅ all exit 0 |
| Design system files modified | ✅ none |

**Caveat worth knowing:** scheduled transitions land within the 60s ISR window,
not instantly. That is a deliberate trade and is the mechanism, not a bug — see
§1.
