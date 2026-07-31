# Catalog — Store Engine (Phase 2)

Read-only commerce. Customers browse, search and filter; nothing can be bought
yet. Cart, checkout, orders and payments are Phase 3+.

Consumes the frozen design system unchanged — no component was redesigned, and
no design file is touched by this phase.

---

## 1. Architecture review

### Two structural rules

**A product is a thing; a variant is the thing you buy.** Price, SKU, weight
and inventory live on `product_variants`, never on `products`. A strain sold in
five weights is one product and five variants, so changing the 3.5g price cannot
silently move the 28g price, and stock is counted against the unit that actually
leaves the shelf.

**Images are records, not columns.** `products` has no image URL. Media are rows
in `media`, attached through `product_media`, so one photograph can serve several
products, carries its own alt text and dimensions, and can be reordered without
touching the product.

### Three layers, three visibilities

| Layer | File | Sees |
| --- | --- | --- |
| Public reads | `lib/catalog/queries.ts` | `status = 'active'` and `deleted_at is null`, **enforced in one function** |
| Admin reads | `lib/catalog/admin-queries.ts` | Everything, including drafts and archives |
| Admin writes | `lib/catalog/admin-actions.ts` | Everything, behind `requireAdmin()` |

The public and admin read layers are deliberately separate modules rather than
one module with an `includeDrafts` flag. A flag is how unreleased product
eventually reaches a customer: someone adds a call site, forgets the argument,
and nothing fails loudly. Here the public query *cannot express* a draft.

`admin-queries.ts` exports plain async functions, **not** Server Actions. A
`'use server'` module turns every export into a callable public endpoint, and a
list query taking an id from the caller is exactly the wrong thing to expose.

### Server Components by default

The entire storefront — shop, category, product detail — is Server Components.
There is **no client JavaScript in the catalog at all**.

Search and filtering are a plain `GET` form whose fields are the query string.
Submitting navigates; the server re-renders. That gives shareable, bookmarkable,
crawlable URLs and a working back button for free — all of which a
`useState`-driven filter panel has to reimplement, usually worse. Pagination is
ordinary links for the same reason.

Client Components appear only in admin forms, which genuinely need form state.

### Brand intensity (DESIGN.md §9)

| Surface | Intensity | What it uses |
| --- | --- | --- |
| Category pages | 70% | Halftone accent, panel outlines, display headings, sticker badges. No ambient smoke. |
| Product detail | 50% | Panel outlines, display name, **one** badge. No smoke, no halftone washes. |
| Admin | 5% | Type, hairlines, tabular data. |

Data is shaped to fit the existing `ProductCard` contract rather than the card
being changed to fit the data — `category` becomes the eyebrow
("Indica · Flower"), `size` the entry variant's label.

---

## 2. Schema

```
brands ──┐
         ├──< products ──< product_variants
categories ┘      │
                  └──< product_media >── media
```

### Tables

| Table | Purpose | Notes |
| --- | --- | --- |
| `brands` | Cultivator / manufacturer | `logo_media_id` references `media`, never a raw URL |
| `categories` | Flower, Edibles, … | `parent_id` self-reference reserved for future sub-categories; `sort_order` drives nav order |
| `products` | A strain or item | Cannabis attributes live here; all nullable, because accessories and apparel have none |
| `product_variants` | **The purchasable unit** | SKU, label, weight, price, compare-at, inventory |
| `media` | Reusable image records | `alt_text` is `NOT NULL DEFAULT ''` |
| `product_media` | Join | `sort_order`, `is_primary` |

### Decisions worth defending

**Money is integer cents.** `price_cents`, `compare_at_price_cents`. Never
floats — `0.1 + 0.2 !== 0.3`, and a cannabis retailer reconciles excise and
sales tax to the cent for state reporting.

**Potency is `numeric`, not float.** THC/CBD percentages are printed on labels,
quoted to regulators and compared against lab results. They must round-trip
exactly.

**`alt_text` is required, not nullable.** An empty string is a valid, deliberate
value meaning "decorative". Making the column nullable is how alt text quietly
stops existing.

**Effects and flavours are `text[]` with GIN indexes, not join tables.** Join
tables would be more normalised and would be right if these needed their own
descriptions or translations. They do not — they are labels used for filtering.
Two arrays and two indexes answer "everything tagged energizing" without four
extra tables. If faceted search later needs canonical names, promoting them is a
contained migration.

**Terpenes are `jsonb`** (`{ myrcene: 0.62 }`) because each entry carries a
value, and no query targets an individual terpene yet.

**Foreign key behaviour is chosen per relationship, not by habit:**

| Relationship | Rule | Why |
| --- | --- | --- |
| product → brand / category | `restrict` | Deleting a brand with live products should fail loudly, not orphan the catalog |
| variant → product | `cascade` | A variant has no meaning without its product |
| product_media → product / media | `cascade` | The association is meaningless without either side |
| brand → logo media | `set null` | The brand survives losing its logo |

**One primary image per product is enforced by the database**, not by hoping the
application remembers:

```sql
create unique index product_media_one_primary_per_product
  on product_media (product_id) where is_primary;
```

**Deletes are soft** for brands, categories, products and variants. Cannabis
retail is record-retention regulated, and hard deletes would break historic
orders the moment Phase 3 exists. Deleting a variant keeps its SKU claimed by
the unique index — reusing a retired SKU would make stock history ambiguous.

### Cannabis attributes

Captured now even where the UI does not yet surface all of them, because
backfilling potency and lineage across a live catalog is far more painful than
carrying nullable columns from the start.

`strain_type` (indica/sativa/hybrid/cbd) · `thc_percent` · `cbd_percent` ·
`genetics` · `effects[]` · `flavors[]` · `terpenes` · `lab_test_reference` ·
`lab_test_url` · `featured` · `new_arrival`, plus per-unit `thc_mg` / `cbd_mg`
on variants for edibles and beverages.

### Future compatibility

Not implemented. Nothing here blocks them:

| Feature | Path |
| --- | --- |
| Discounts | Money is already integer cents; `compare_at_price_cents` models a strike-through. A `discounts` table can target product, variant or category without altering these tables. |
| Bundles | A bundle is a product whose variants map to component variants via `bundle_items`. Nothing assumes a variant is one physical item. |
| Loyalty | Lives on the customer, not the catalog. |
| Multiple locations | `inventory_quantity` is the single-location quantity the brief specifies. Multi-location becomes `inventory_levels(variant_id, store_id, quantity)`, **backfilled from this column** — additive, not a redesign. `stores` already exists to point at. |
| Wholesale pricing | `price_tiers(variant_id, customer_group, price)` layered over the variant's list price. |

---

## 3. Performance

**Listing is three round trips regardless of result size.**

1. products + brand + category — joined, filtered, sorted, paginated
2. variants for that page — one `where product_id in (…)`
3. primary media for that page — one `where product_id in (…)`

Assembly happens in memory. The obvious alternative — loading variants per
product — is an N+1 that turns a 24-product page into 49 queries. The other
obvious alternative, one big join, multiplies product rows by variant rows and
makes `LIMIT` wrong.

### Indexes

```
products_status_category_idx   (status, category_id)   ← the storefront's hottest query
products_status_idx            (status)
products_brand_id_idx          (brand_id)
products_featured_idx          (featured)
products_strain_type_idx       (strain_type)
products_effects_gin           GIN(effects)
products_flavors_gin           GIN(flavors)
product_variants_product_id_idx
product_media_product_id_idx
```

### Known limits, stated honestly

- **Search is `ILIKE '%term%'`** across product name, short description, brand
  name and category name. At catalog scale (tens to low hundreds of products)
  this is correct and fast. It cannot use a btree index, so at thousands of
  products the upgrade is a `tsvector` column with a GIN index, or `pg_trgm`.
  The brief said keep it simple and not over-engineer; this is the simple thing,
  and the upgrade path is a contained migration.
- **Price sorting uses a correlated subquery** over the cheapest active variant.
  Correct under pagination, and cheap at this scale. If it ever shows up in a
  slow-query log, denormalise a `min_price_cents` onto `products`, maintained on
  variant write.
- **Images are `<img>`, not `next/image`.** Explicit `width`/`height`,
  `loading="lazy"` and `decoding="async"` reserve layout and keep decode off the
  main thread. `next/image` lands with Vercel Blob uploads.
- Seed imagery is deterministic SVG data URIs, so the seed has **zero network
  dependencies**.

---

## 4. Accessibility

Inherits the frozen system's guarantees — contrast, 44px targets, focus rings —
and adds:

- **Variant and admin tables are real tables** with `<caption class="sr-only">`,
  `<th scope="col">` and `<th scope="row">`, so a screen reader announces "5 pk,
  price $50.00, only 3 left" rather than reading a grid of orphaned cells.
- **Result counts are `aria-live="polite"`**, so filtering announces "9 products"
  without stealing focus.
- **Breadcrumbs** use `<nav aria-label="Breadcrumb">` with `aria-current="page"`.
- **Category chips** are a `<nav>` + `<ul>` of links with `aria-current`, not
  buttons — they navigate, so they are links.
- **Every filter control has a visible `<label>`.** No placeholder-as-label.
- **Stock is never colour alone**: "In stock", "Only 3 left" and "Sold out" are
  text, with colour as reinforcement.
- **Product grids are `<ul>`/`<li>`**, so the count is announced.
- Search and pagination work with **JavaScript disabled**.
- Images carry real alt text from the `media` record; decorative placeholders
  are `aria-hidden`.

---

## 5. Migration summary

**`0003_lean_starbolt.sql`** — additive only. No `DROP`, no `TRUNCATE`, no
`ALTER COLUMN` on existing tables.

| | |
| --- | --- |
| New enums | `product_status`, `strain_type` |
| New tables | `brands`, `categories`, `media`, `products`, `product_variants`, `product_media` |
| New indexes | 21, including two GIN and one partial unique |
| Existing tables touched | **none** |

Applied to the **development branch only**. Production has migrations 0000–0002;
0003 is not applied there and should not be until this phase is approved.

```bash
npm run db:migrate         # apply
npm run db:seed:catalog    # populate
npm run db:inspect         # confirm target and table list
```

### Seed coverage

5 brands · 7 categories · 12 products · 43 variants · 24 media assets.

Deliberately includes every state the UI must handle: featured products, new
arrivals, a **fully out-of-stock** product, **low-stock** variants (3 remaining),
a **draft** that must never appear publicly, an **archived** product, five-weight
flower, single-variant accessories, and non-cannabis items with no strain type
or potency. Idempotent — every insert upserts on its natural key.

---

## 6. Verified

| Check | Result |
| --- | --- |
| Draft product hidden from `/shop` | ✅ 0 occurrences |
| Draft product page leaks nothing | ✅ 0 of name, potency, SKU, description |
| Archived product likewise hidden | ✅ |
| Search: name / brand / category | ✅ "haze" 1, "northside" 1, "flower" 4, nonsense 0 |
| Filter: strain / category / in-stock | ✅ 2 / 4 / 9 |
| Sold-out card state | ✅ |
| Low-stock ("Only 3 left") | ✅ |
| Compare-at strike-through | ✅ |
| Admin routes, no session | ✅ 307 |
| Admin routes, forged cookie | ✅ no data rendered |
| build / lint / typecheck | ✅ all exit 0 |

**Status-code note.** `notFound()` on an unknown or draft product returns **200**
with the 404 body rather than a 404 status, because the interrupt is raised
after Next has begun streaming. This is the same framework behaviour documented
in AUTHENTICATION.md §5 for `redirect()`/`forbidden()`, it was measured, and it
is not a leak — the guarded content never renders. Worth revisiting before
launch for SEO reasons, since crawlers read the status.
