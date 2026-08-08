# Media privacy

**Status: RESOLVED in code. One operational precondition remains — see §5.**

This document opened as a finding: the Phase 5 login wall did not protect
product media. It is kept as the record of what was wrong, what was done, and
what is still true afterwards.

---

## 1. The original finding

CloudMarket stored all product media in **Vercel Blob, in a `public` store**.
Every uploaded object was served from:

```
https://<store-id>.public.blob.vercel-storage.com/product-media/<name>-<suffix>
```

**That URL was world-readable, permanently, with no session and no expiry.**

It was not protected by the proxy (a different origin — our proxy never saw the
request), by the Data Access Layer (never invoked), by the invite gate (no
account involved), or by `robots.txt` (a request to crawlers, not access
control). The storefront became private in Phase 5; the media did not. Anyone
holding a URL — a former customer, someone sent a screenshot with the address
bar visible, an ex-employee, anyone who crawled the site while it was public,
anyone with a database dump — could fetch that object forever.

`addRandomSuffix: true` made the URLs unguessable, which is a real mitigation
and is not a control. URLs leak: through `Referer` headers, browser history,
shared links, screenshots, proxy logs, corporate TLS inspection, and any future
page that renders one.

---

## 2. What was done

Two changes, and both are necessary. Either one alone leaves the finding open.

### 2.1 Storage — nothing is written world-readable

`lib/media/constants.ts` declares `MEDIA_ACCESS = 'private'`, and both upload
clients pass it to `upload()`. A private object cannot be fetched by URL at all;
reading it requires the store's read-write token, which exists only on the
server.

It is a **constant, not a setting**. An environment variable that could flip it
to `public` would be a way to un-privatise the catalog by editing a dashboard,
and every object created while it was wrong would stay world-readable
afterwards.

`access` is chosen by the client at upload time and the token this application
issues cannot constrain it, so `finalizeUploadAction` closes that gap from the
other side: **an object that did not land on the private host is deleted and
never becomes a row.** A modified admin client cannot introduce a public object
into the catalog, and a misconfigured store fails loudly rather than silently
reverting to a public CDN.

### 2.2 Serving — every fetch passes the Data Access Layer

Media reaches a browser as `/api/media/<media-id>` and nothing else. The route
(`app/api/media/[id]/route.ts`) calls `getCurrentUser()` before it reads the
parameter, answers **401 with an empty body** to anyone without a session, and
streams the bytes from private storage using the server's credential
(`lib/media/serve.ts`).

The substitution happens in the **query layer** — `lib/media/queries.ts`,
`lib/cms/queries.ts`, `lib/catalog/admin-queries.ts`, `lib/bag/core.ts` — not in
the components. A DTO cannot leak an address it was never given, and a property
enforced at twenty call sites is a property that survives until somebody adds
the twenty-first.

### 2.3 Everything that followed from those two

| Change | Why |
|---|---|
| `components/catalog/media-image.tsx` renders a plain `<img>` | Next's image optimizer fetches the source server-side without the viewer's cookies, so it would get a 401. It also destroys animated GIFs. |
| `next.config.ts` `remotePatterns: []` | There is no remote host to optimize from any more. An empty list makes a future remote URL fail loudly instead of turning the optimizer into an image proxy. |
| CSP `img-src 'self'`, `media-src 'self'` | Media is same-origin now. The Blob host remains in `connect-src` only, because admin uploads still PUT to it directly. |
| `finalizeUploadAction` reads bytes via the SDK | A plain `fetch` of a private object returns 403. The magic-byte sniffing that gates every upload now runs over a credentialed read. |
| Admin media library shows a **Public URL** badge | The one remaining exposure is a data condition, and an operator cannot act on a finding they cannot see. |

---

## 3. What this design costs

Stated plainly, because the alternative was cheaper and was rejected on purpose.

**Bandwidth and function time.** Every image on every page is an authenticated
request through a serverless function rather than a CDN edge hit. Range requests
are forwarded, so video seeking works and a player fetches only what it plays,
but a video watched to the end moves its whole size through the function.
Conditional requests are honoured (`If-None-Match` in, `ETag` out) and responses
carry `Cache-Control: private, max-age=300, must-revalidate`, so a browser
revalidates cheaply and the cost tracks distinct assets viewed rather than page
views.

**No server-side resizing.** A 4000px pack shot is sent at 4000px to a card that
displays it at 300. The mitigation is operational — upload sensibly sized assets
— and it was accepted rather than solved.

### Why not signed URLs?

`@vercel/blob@2.6.1` supports `issueSignedToken()` + `presignUrl()`, and
redirecting to a short-lived signed CDN URL would have kept the CDN and cost
almost nothing. It was not chosen because **a signed URL is a bearer token**:
for the length of its TTL anyone holding it can fetch the object with no session
at all, and it lands in browser history, `Referer` headers, screenshots and
intermediary logs exactly as the permanent URL did. That converts a permanent
exposure into a repeated short one — an improvement, not a fix.

The property this design has and that one cannot: **access ends when the session
ends.** `scripts/verify-product-media-http.mjs` §4 asserts it — the same URL,
from the same browser, returns 401 the moment the session is destroyed.

---

## 4. What is still true afterwards

- **A pasted third-party URL is redirected to, not proxied.** Assets added
  through "Add by URL" live on somebody else's host and were public before this
  application referenced them. Proxying them would make the route a
  general-purpose fetcher for whatever an administrator once typed into a form —
  an SSRF primitive with a session check in front of it.
- **Any object that was public in the past is still public.** Deleting a row
  does not unpublish bytes that have already been copied. This is why §5 exists.
- **An administrator can still read everything.** They upload it and hold the
  store credential. The boundary being enforced is "inside the invite-only
  storefront", not "need to know".
- **Any signed-in user may fetch any asset, deliberately.** Product photography
  is shown to every customer who can reach the catalog, so a per-asset rule
  would have to allow everything the storefront displays. If media ever carries
  something narrower — a lab report naming a customer — it needs its own route
  with its own rule, not a widened one here.
- **SVG remains rejected outright.** An SVG served from our own origin is
  same-origin JavaScript, and no sanitizer is present.

---

## 5. The remaining precondition

**The Blob store `BLOB_READ_WRITE_TOKEN` points at must support private
objects.**

If it does not, uploads fail at finalization with *"That upload was stored
publicly and has been removed"*, and the object is deleted. That is the correct
failure — nothing degrades to public — but it means media cannot be uploaded
until the store is right. Verify before the first upload, not after.

**Objects already in a public store must be re-uploaded.** For production this
is currently a no-op: the production catalog is empty, so there are no objects
to migrate. Where public objects do exist:

1. Re-upload each one through the admin UI so it lands in the private store.
2. Delete the old asset, which deletes the object from the public store.
3. Re-run `npm run test:media:privacy` — §G fails while any row still points at
   `*.public.blob.vercel-storage.com`.

Step 2 is the one that actually removes the exposure. Until the object is
deleted from the public store, its old URL keeps working for anyone who has it.

---

## 6. How this is held in place

| Suite | What it proves |
|---|---|
| `npm run test:media:privacy` | Uploads are private; URL classification, including SSRF lookalikes; response headers forbid shared caching; the route is absent from the public allowlist; **every live DTO carries `/api/media/<id>` and no storage address**; no row points at a public object. |
| `npm run test:media` | The upload path: magic-byte sniffing, size ceilings, GIF animation survival, gallery ordering. |
| `node scripts/verify-product-media-http.mjs` | Over real HTTP: 401 signed out, 200 signed in, 404 on unknown and malformed ids, **401 again once the session is destroyed**, and no `blob.vercel-storage.com` anywhere in a rendered product page. |

The first two run in `npm test`. The third needs a built server and is listed in
the runbook's post-deploy checks.
