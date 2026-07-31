# Database — environments, branches, and connection strings

Cloud Market runs on [Neon](https://neon.tech) Postgres. Neon branches are
copy-on-write: a branch is a cheap delta against its parent, not a copy of the
data. That property is what makes a throwaway database per pull request
practical, and it drives every decision below.

---

## 1. Branch model

| Neon branch | Role | Lifetime |
| --- | --- | --- |
| `main` | **Production.** The default branch, root of the branch tree. | Permanent |
| `preview/<git-branch>` | One isolated database per preview deployment. | Created with the PR, deleted with it |

`main` is production because it is the only branch guaranteed to exist: it is
the root every other branch is a delta against, deleting a parent deletes its
children, and child branches are `reset`-able as a routine dev operation.
Production must not sit behind a footgun that ordinary.

**Never point a preview deployment at `main`.** Preview code is unreviewed by
definition; a migration or a seed run against `main` is a production incident.

---

## 2. Environment variable strategy

Two connection strings, because they are not interchangeable:

| Variable | Neon endpoint | Host contains | Used by |
| --- | --- | --- | --- |
| `DATABASE_URL` | Pooled (PgBouncer) | `-pooler` | The application at runtime |
| `DATABASE_URL_UNPOOLED` | Direct | *no* `-pooler` | `drizzle-kit` migrations |

Migrations use the direct endpoint because DDL over a connection pooler can fail
part-way through, leaving the schema in a state the migration journal does not
describe. [`drizzle.config.ts`](./drizzle.config.ts) enforces this by preferring
`DATABASE_URL_UNPOOLED` and only falling back to `DATABASE_URL`.

### Which variables exist in which Vercel environment

| Variable | Production | Preview | Development |
| --- | --- | --- | --- |
| `DATABASE_URL` | Neon `main`, pooled | **branch-scoped only** (set per git branch by the Neon integration) | *not set* |
| `DATABASE_URL_UNPOOLED` | Neon `main`, direct | **branch-scoped only** | *not set* |
| `AUTH_SECRET` | ✅ | ✅ | ✅ |
| `NEXT_PUBLIC_APP_URL` | production domain | production domain | `http://localhost:3000` |

Optional and unset until their phase lands: `BLOB_READ_WRITE_TOKEN` (Phase 3),
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_SERVER_API_KEY` (Phase 7).
All three are `.optional()` in [`lib/env.ts`](./lib/env.ts), so their absence is
not a build failure.

### ⚠️ The unscoped-Preview trap

This is the single most important rule in this document.

A Vercel environment variable set on **Preview without a git-branch scope acts
as the fallback for every branch that has no scoped value.** So an unscoped
Preview `DATABASE_URL` holding the production string silently defeats branch
isolation entirely — every preview without its own Neon branch quietly reads and
writes production, and nothing in the deployment output says so.

**There must be no unscoped Preview value for `DATABASE_URL` or
`DATABASE_URL_UNPOOLED`.** Absent is correct. A preview with no Neon branch
attached must fail closed, not fall back.

Verify with `vercel env ls` — neither variable should appear with a bare
`Preview` environment and no branch scope.

### Why Development has no database credentials

Anything in the Development environment is handed out by `vercel env pull`.
Production connection strings there mean every developer's laptop holds live
production credentials, and a stray `npm run db:seed` writes to production.

Local development uses `.env.local` instead, which is gitignored
(`.gitignore` line 34, `.env*`). Copy [`.env.example`](./.env.example) and fill
it in. Point it at your own Neon branch — not `main`.

---

## 3. Preview branches

Preview isolation is provided by the **Neon integration for Vercel**, which
connects the existing Neon project to the Vercel project. On each preview
deployment it creates a Neon branch from `main` and sets `DATABASE_URL` as a
**branch-scoped Preview variable** for that git branch, then removes the branch
when the git branch goes away.

> **When installing:** choose the integration option that **connects an existing
> Neon project**. The Marketplace also offers a flow that *provisions a new*
> Neon database billed through Vercel — that would create a second, empty
> project and leave the real one unconnected. Select the existing
> `cloud-market` project, and scope it to the `cloud-market` Vercel project.

Because branches are copy-on-write from `main`, a fresh preview branch already
has the production schema and seed data. It does **not** need `db:migrate` re-run
unless the PR itself adds a migration — in which case run it against the preview
branch's direct endpoint, never against `main`.

If the integration does not set `DATABASE_URL_UNPOOLED`, migrations inside a
preview must be run manually against that branch's direct endpoint. Derive it
from the pooled host by removing `-pooler`.

---

## 4. Verifying isolation

`GET /api/health` reports which database the running instance actually reached:

```json
{
  "status": "ok",
  "environment": "preview",
  "database": {
    "configured": true,
    "reachable": true,
    "fingerprint": "3f9a1c02b7de",
    "latencyMs": 71
  },
  "timestamp": "..."
}
```

`fingerprint` is the first 12 hex characters of `sha256(connection hostname)`.
The raw hostname is deliberately not exposed — this endpoint is unauthenticated,
and publishing the exact Neon endpoint hands an attacker a target. The digest is
sufficient for the only question that matters:

```bash
curl -s https://<production-domain>/api/health   # note the fingerprint
curl -s https://<preview-domain>/api/health      # compare
```

- **Different fingerprints** → the preview is on its own Neon branch. Isolated. ✅
- **Identical fingerprints** → the preview is talking to production. Stop and
  fix the unscoped-Preview fallback described above. ❌
- **`"configured": false`, HTTP 503** → no `DATABASE_URL` in that environment.
  This is the correct fail-closed state for a preview with no Neon branch — safe,
  but the integration is not wired up.

`environment` echoes Vercel's `VERCEL_ENV`, so a response also proves which
deployment target answered.

---

## 5. Migrations and seeding

```bash
npm run db:generate   # author a migration from schema changes
npm run db:migrate    # apply pending migrations (uses the DIRECT endpoint)
npm run db:seed       # idempotent; upserts the launch store on `slug`
```

Both read `.env.local`. **They target whatever that file points at** — there is
no environment guard. Check where it points before running either.

`db:seed` is idempotent by design (`onConflictDoUpdate` on `stores.slug`), so
re-running with corrected values overwrites rather than duplicating.

---

## 6. Operational notes

- **Protect `main` in Neon.** Branch protection prevents accidental reset or
  delete of production. It is a paid-plan feature; the project is currently on
  Hobby.
- **Region.** Neon is `aws-us-east-2` (Ohio); Vercel functions run in `iad1`
  (Virginia). Warm query latency is ~70–130 ms including that cross-region hop.
  Colocating is worth revisiting when traffic justifies it.
- **Rotation.** Connection strings live in two places — the Neon console and the
  Vercel project. Rotating the password means updating both, plus any local
  `.env.local`.
