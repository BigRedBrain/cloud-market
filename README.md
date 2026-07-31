# Cloud Market

Cannabis ordering and delivery for a licensed Michigan dispensary.

Launches as a single store with a single owner/driver. The data model and
architecture are built so that additional stores and drivers can be added
without redesign.

## Requirements

- Node.js 20.9+ (Next.js 16 minimum; developed on 24.x)
- A Neon Postgres database

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run db:migrate           # apply migrations
npm run db:seed              # create the launch store
npm run dev
```

`lib/env.ts` validates every environment variable at startup. A missing or
malformed value fails loudly at boot rather than surfacing as a confusing
runtime error later.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server (Turbopack) |
| `npm run build` | Production build; fails on type errors |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run db:generate` | Generate SQL migrations from the Drizzle schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema directly — local development only |
| `npm run db:studio` | Drizzle Studio |
| `npm run db:seed` | Seed the launch store (idempotent) |

## Architecture

```
app/                  Routes, layouts, error boundaries (Server Components by default)
components/ui/        shadcn/ui primitives
lib/
  env.ts              Zod-validated environment
  db/
    index.ts          Drizzle client (server-only)
    schema/           Table definitions, one module per domain area
    seed.ts           Idempotent seed script
  result.ts           ActionResult — the Server Action return contract
  money.ts            Integer-cent money type and arithmetic
  utils.ts            cn() class merger
drizzle/              Generated SQL migrations (committed)
```

### Conventions

- **Server Components by default.** `'use client'` is opt-in, pushed as far down
  the tree as possible.
- **All input is validated with Zod** at the trust boundary. Server Actions take
  untrusted input and must funnel it through `parseInput()`.
- **Server Actions return `ActionResult<T>`**, never throw across the boundary.
  See `lib/result.ts`.
- **Money is integer cents**, never floats. See `lib/money.ts`. The `Cents`
  branded type makes a dollars/cents mix-up a compile error.
- **Every tenant-owned table carries `store_id`** from day one, so adding a
  second store is a data operation rather than a migration.
- **Regulated records are soft-deleted** (`deleted_at`) for retention
  compliance.

### Notes on Next.js 16

This project targets Next.js 16, which differs materially from 15:

- `middleware.ts` is now `proxy.ts` and runs on the **Node.js runtime only**.
  This is why Auth.js can use database sessions directly (Phase 1).
- `cookies()`, `headers()`, `draftMode()`, `params` and `searchParams` are
  **async-only** — synchronous access was removed.
- `revalidateTag(tag)` now requires a `cacheLife` profile as a second argument.
  `updateTag()` provides read-your-writes semantics inside Server Actions.
- Turbopack is the default bundler; `next lint` has been removed in favour of
  the ESLint CLI.
- PPR is configured via top-level `cacheComponents`, not `experimental.ppr`.

Consult `node_modules/next/dist/docs/` — the bundled docs match the installed
version exactly.

## Build phases

0. **Foundation** — tooling, database, env, design tokens ✅
0.5. **Design system** — brand, components, motion policy ✅ **frozen**
1. Authentication
2. Admin Dashboard
2.5. CMS & Marketing Engine — includes **Campaign Composer** (below)
3. Product Catalog
4. Shopping Cart
5. Checkout
6. Order Management
7. Delivery Workflow
8. Launch

The design system is frozen as of Phase 0.5. Every phase from 1 onward consumes
it rather than extending it — see [DESIGN.md](./DESIGN.md), in particular the
brand intensity scale (§9), which tells you how much brand a given screen should
carry. Visual changes need a bug, not a preference.

### Campaign Composer (Phase 2.5)

Hero layouts must not be hardcoded per promotion. The admin picks a **campaign
template**, chooses products, sets a date range, and publishes; the design
system renders it.

Templates to support:

| | |
| --- | --- |
| New Drop | Limited Supply |
| Weekend Sale | Staff Pick |
| Flash Sale | Event Promotion |
| Holiday Campaign | Brand Collaboration |

Each template is a fixed composition of existing primitives — hero, badge,
product grid, countdown — bound to a brand intensity from §9. A campaign cannot
introduce new colours, fonts, motion, or components. That constraint is the
point: it is what stops eight promotions becoming eight visual languages.
