# CloudMarket — Website + Mobile App Master Specification

**Purpose:** Source-of-truth handoff for Claude, developers, designers, and future implementation work.
**Platforms:** Responsive web application + iOS app + Android app.
**Core concept:** A private, invite/application-only multi-vendor marketplace wrapped in a gritty hip-hop comic-book “Cloud 9” visual world.

---

## 1. Product Vision

CloudMarket is a **private membership marketplace**, not a public storefront. Visitors may see the branded landing/gate experience, but products, prices, vendor inventory, search, and transactional areas remain behind approved membership.

A person can enter CloudMarket in one of two ways:

1. Apply as a shopper or vendor and be approved.
2. Redeem a valid invite code for the appropriate role.

The website and mobile apps must share the same brand language, accounts, permissions, marketplace data, feature flags, and backend business rules.

The marketplace should have the browsing utility and density of an eBay-style marketplace while remaining completely original in appearance.

---

## 2. Non-Negotiable Requirements

- Private marketplace.
- Invite-code or application-based access.
- Separate shopper and vendor application paths.
- Admin approval workflow.
- Matching web, iOS, and Android experiences.
- Gritty hip-hop comic aesthetic.
- Cannabis bud mascot pushing a shopping cart.
- Cloud-on-fire logo/motif.
- Vibrant white, pearl, dark smoke, yellow, and red palette.
- Permanent Marker-style display typography.
- Animated Cloud 9 landing experience.
- Animated cloud/smoke environment.
- Product cards styled like comic clouds on fire.
- Animated header/navigation motif with mascot/cart movement.
- Multi-vendor architecture.
- Strong admin moderation and auditability.
- Regulated-commerce features must remain feature-gated.
- Checkout, crypto, auctions, pickup, and delivery must not be enabled simply because code exists.
- No assumption that shipping/fulfillment is lawful in every jurisdiction.

---

## 3. Current Technical Baseline — Preserve It

### Existing web stack

- Existing CloudMarket web application is Next.js.
- Production deploys through Vercel.
- PostgreSQL is hosted on Neon.
- Drizzle manages database schema/migrations.
- Production branch is `main`.
- Current deployed catalog/strain work includes commit `6df5e9b`.
- Migration history includes `0018_strain_leaning_types`.

### Existing strain model

- `indica` → Indica
- `sativa` → Sativa
- `hybrid` → Hybrid
- `hybrid_i` → Hybrid I
- `hybrid_s` → Hybrid S
- `cbd` → CBD

Never display raw enum values such as `hybrid_i` to users.

### Existing catalog foundation

CloudMarket already has concepts/tables for brands, categories, products, variants, media, product-media links, collections, badges, campaigns, purchase limits, and catalog compliance.

Production must be evolved with additive migrations. Do not reset or reseed it.

### Current production safety gates

- Checkout remains disabled.
- Crypto payments remain disabled.
- Production database privileges are hardened.
- Existing purchase-limit rules must not be replaced casually.
- Fulfillment settings remain disabled until explicitly configured and verified.

### Media

The currently deployed admin media workflow stores media by URL. A more advanced authenticated/private Vercel Blob upload + server-side finalization design exists in Phase 5 development work and should be reused intentionally rather than creating a second incompatible upload system.

### Initial catalog import

A 15-product RedBeards Exotic Budz flower catalog is prepared for import.

Rules:
- products enter as draft;
- do not invent THC/CBD;
- do not invent lab references;
- do not create sellable variants until real price/stock exists;
- reference/extracted photography must be verified before being treated as final batch photography;
- use the existing `Flower` category;
- use the existing `RedBeards Exotic Budz` brand.

---

## 4. Brand Identity

### Primary logo concept

A **gritty cloud on fire** with a **comic-style cannabis bud character pushing a shopping cart**, floating/riding on the cloud.

The identity must feel:
- hip-hop;
- gritty;
- premium streetwear;
- underground;
- comic-book inspired;
- energetic;
- memorable;
- not childish.

Avoid:
- generic cannabis leaf logos;
- generic SaaS styling;
- pastel/cute cloud design;
- heavy neon cyberpunk styling;
- excessive green as the primary brand color.

### Required brand assets

1. Primary horizontal logo.
2. Compact logo.
3. App icon.
4. Mascot-only artwork.
5. Mascot poses: pushing cart, riding/floating, pointing to CTA, celebrating, browsing, vendor pose, shopper pose, idle pose.
6. Cloud/fire card frames.
7. Monochrome logo.
8. Background cloud/smoke layers.
9. Animated hero assets.

---

## 5. Color System

Final hex values should be locked after logo approval. Working direction:

- **Cloud White** — bright clean white.
- **Pearl** — warm/off-white pearlescent tone.
- **Dark Smoke** — near-black charcoal.
- **Smoke Gray** — layered mid-gray.
- **Signal Yellow** — energetic yellow accent.
- **Fire Red** — bold red accent.

Usage:
- Dark Smoke: shell, nav, overlays, dark panels.
- White/Pearl: cloud art, content surfaces, readable areas.
- Yellow: sparks, highlights, selected CTAs.
- Red: fire, selected primary accents, active moments.

Red should not be used for every button.

---

## 6. Typography

### Display font
Use **Permanent Marker** or the approved Permanent Marker-style face for:
- hero headlines;
- section headings;
- comic callouts;
- promotional banners;
- selected buttons.

### UI/body font
Use a clean, highly readable sans-serif for:
- forms;
- prices;
- filters;
- product details;
- admin tables;
- vendor dashboard data;
- legal text.

Permanent Marker must not be used for dense paragraphs or critical data.

---

## 7. Motion Language

The experience should feel like: **“I’m floating on Cloud 9.”**

### Background cloud drift
- layered clouds;
- different movement speeds;
- subtle parallax;
- seamless loops where possible.

### Smoke
- slow ambient movement;
- never cover controls/text.

### Mascot/cart loop
Use in:
- landing hero;
- header transitions;
- selected loading/empty states;
- section transitions.

### Fire
Comic flame flicker, not photorealistic fire.

### Product cards
On hover/tap:
- slight float/lift;
- subtle smoke/fire reaction;
- no excessive 3D spinning.

### Reduced motion
Honor reduced-motion preferences. Continuous parallax and mascot loops must become static while all functionality remains intact.

---

## 8. Public vs. Private Experience

### Public zone
Guests may access:
- landing/gate;
- sign in;
- invite redemption;
- shopper application;
- vendor application;
- application status;
- account recovery;
- legal/privacy/help.

Guests must NOT access:
- live catalog;
- prices;
- vendor inventory;
- private vendor pages;
- marketplace search;
- order data.

### Private marketplace
Approved members may access:
- marketplace home;
- shop/search;
- products;
- vendor pages;
- favorites/watchlist;
- bag/cart when enabled;
- orders when enabled;
- account;
- notifications.

Vendor members also receive vendor tools.

---

## 9. Roles

### Guest
Can view gate, apply, redeem invite, sign in, recover account, view public legal/help.

### Applicant
Can see application status and provide requested information. No marketplace access until approved.

### Shopper
Can browse, search, favorite/watch, manage account, and use cart/orders only when those features are enabled.

### Vendor Owner
Can manage vendor profile, listings, inventory, media, vendor orders, staff, and analytics. Cannot access platform-global admin controls.

### Vendor Staff
Vendor-scoped permissions such as catalog editing, inventory, fulfillment, or analytics.

### CloudMarket Admin
Can review applications, manage invites, moderate users/vendors/listings, manage CMS/catalog/compliance, and audit activity.

### CloudMarket Owner
Highest privileged platform role. Preserve the existing owner/backup-admin security concept. Vendor users must never become platform admins implicitly.

---

## 10. Invite System

Each invite should support:
- unique code;
- shopper/vendor target role;
- active/inactive;
- created by/date;
- expiration;
- max uses/current uses;
- notes/source/campaign;
- optional vendor association;
- revoke metadata.

Security requirements:
- store invite secrets non-reversibly where practical;
- rate-limit redemption attempts;
- audit create/revoke/redeem/fail events;
- never disclose whether a bad code was “close.”

Redemption flow:
1. Enter invite code.
2. Validate server-side.
3. Sign in/create account.
4. Collect required profile fields.
5. Grant role according to invite scope.
6. Enter private marketplace.

Vendor invite recipients may still need vendor-profile/compliance completion before selling.

---

## 11. Application System

### Shopper application
Suggested fields:
- name;
- email;
- phone if required;
- state/jurisdiction;
- age-eligibility attestation;
- referral/invite source;
- marketplace-rules acknowledgement;
- privacy/consent acknowledgement.

Avoid collecting more sensitive identity information than required.

Statuses:
- draft;
- submitted;
- under_review;
- needs_information;
- approved;
- rejected;
- waitlisted;
- withdrawn;
- suspended.

### Vendor application
Suggested fields:
- contact name;
- email/phone;
- business/display name;
- legal business name where required;
- state/jurisdiction;
- business type;
- license type/identifier/expiry where applicable;
- product categories;
- website/social links optional;
- brand description;
- logo/media;
- fulfillment capabilities;
- compliance contact;
- vendor-rules acknowledgement.

Admin review must support queue, filters, detail, internal notes, request-information, approve, reject, suspend, and audit history.

---

## 12. Information Architecture

### Public routes
- `/`
- `/sign-in`
- `/apply`
- `/apply/shopper`
- `/apply/vendor`
- `/invite`
- `/application/status`
- `/forgot-password`
- `/legal/privacy`
- `/legal/terms`

### Private marketplace
- `/market`
- `/shop`
- `/shop/[category]`
- `/product/[slug]`
- `/vendors`
- `/vendors/[slug]`
- `/favorites`
- `/watchlist`
- `/bag`
- `/orders`
- `/orders/[number]`
- `/account`
- `/notifications`

### Vendor
- `/vendor`
- `/vendor/storefront`
- `/vendor/products`
- `/vendor/products/new`
- `/vendor/products/[id]`
- `/vendor/inventory`
- `/vendor/orders`
- `/vendor/media`
- `/vendor/team`
- `/vendor/analytics`
- `/vendor/settings`

### Admin additions
- `/admin/applications`
- `/admin/applications/shoppers`
- `/admin/applications/vendors`
- `/admin/invites`
- `/admin/vendors`
- `/admin/vendor-listings`
- `/admin/moderation`

---

## 13. Public Landing Page

The landing page is the CloudMarket gate.

### Hero
- full-screen/near-full-screen animated scene;
- gritty smoke;
- layered clouds;
- red/yellow comic flames;
- CloudMarket logo;
- mascot pushing cart;
- subtle parallax.

Suggested hierarchy:

**CLOUDMARKET**
**Private marketplace. Cloud 9 access only.**

Primary CTAs:
- **Apply to Shop**
- **Apply to Vend**
- **Enter Invite Code**

Secondary:
- **Sign In**

### Supporting sections
- How CloudMarket Works: Apply/Invite → Approval → Enter Market.
- Vendor CTA.
- Shopper CTA.
- Cloud 9 brand/story panel.
- Legal/help footer.

Do not show live inventory or prices publicly.

---

## 14. Private Marketplace Homepage

### Header
- compact CloudMarket logo;
- animated cloud/fire line;
- search;
- categories;
- vendors;
- favorites/watchlist;
- bag/cart;
- account;
- notifications.

Mascot/cart animation may travel across the header occasionally but may never block navigation.

### Home modules
1. Search/discovery hero.
2. Featured drops.
3. Categories.
4. New arrivals.
5. Vendor spotlight.
6. Trending/watchlisted.
7. Featured auctions if enabled later.
8. Recently viewed.
9. Recommendations later.

---

## 15. Product Cards

Product cards are a signature brand component.

### Visual treatment
- cloud-shaped/cloud-framed container;
- comic black outline;
- white/pearl cloud body;
- smoke depth;
- yellow/red flame accents;
- product image remains dominant;
- slight floating effect.

### Required data
- image;
- product name;
- vendor;
- category;
- strain where relevant;
- size/variant summary;
- price when enabled;
- stock state when enabled;
- featured/new badges;
- favorite/watch control.

Do not make the cloud/fire border so elaborate that names and prices are difficult to scan.

---

## 16. Product Detail Page

Required sections:
- media gallery;
- product name;
- vendor;
- brand;
- category;
- strain label;
- genetics;
- effects;
- flavors;
- verified THC/CBD only;
- verified compliance/lab information only;
- listings/variants;
- favorite/watch;
- vendor link;
- description;
- related items.

If no sellable listing exists, a product may remain a catalog object but must not appear orderable.

---

## 17. Vendor Storefronts

Each approved vendor receives a storefront inside CloudMarket.

Vendor page can include:
- name;
- logo;
- hero image;
- description;
- approved status/badge;
- location/jurisdiction where appropriate;
- categories;
- active listings;
- vendor policies;
- reputation/ratings later.

CloudMarket branding remains visible so users always know they are inside the marketplace.

---

## 18. Multi-Vendor Architecture

A **catalog product** must be separate from a **vendor listing**.

### Product
Canonical catalog object:
- name;
- brand;
- category;
- descriptive attributes;
- strain/genetics/effects/flavors;
- media;
- compliance metadata.

### Vendor
Approved seller organization.

### Vendor Membership
Links users to vendors with vendor-scoped roles.

### Listing
Vendor-specific offer:
- vendor;
- product;
- listing status;
- listing type;
- vendor SKU;
- price;
- inventory;
- size/measurement;
- start/end dates;
- fulfillment flags.

This enables one product to have multiple sellers, prices, inventories, and future auction listings.

Do not overload `products` to serve as vendor ownership/listing data.

---

## 19. Auction Capability

CloudMarket should be auction-ready but auctions are not required for MVP.

Listing types:
- `fixed_price`
- `auction`

Default initial mode: fixed price.

Auction mode remains feature-flagged until deliberately approved.

Possible auction fields:
- start price;
- reserve price optional;
- buy-now price optional;
- bid increment;
- start/end;
- anti-sniping/extension rule optional;
- winning bid/bidder;
- status.

Bid history must be immutable/auditable.

---

## 20. Shopper Experience

Core shopper capabilities:
- membership access;
- marketplace home;
- search/filter;
- category/vendor browsing;
- product detail;
- favorites;
- watchlist;
- recently viewed;
- bag/cart when enabled;
- orders when enabled;
- account/security;
- notifications.

Future:
- saved searches;
- price/watch changes;
- auction outbid notices;
- personalized discovery.

---

## 21. Vendor Dashboard

Vendor UI should retain CloudMarket branding but prioritize operational clarity.

### Overview
- listing count;
- low inventory;
- pending orders;
- activity;
- notifications.

### Listings
- create/edit;
- draft/publish workflow;
- inventory;
- pricing;
- media;
- compliance state.

### Orders
- vendor-related orders;
- fulfillment state;
- only necessary customer data.

### Media
- upload/select;
- attach to products/listings;
- alt text;
- primary image;
- ordering.

### Team
- invite staff;
- scoped roles;
- deactivate access.

### Analytics later
- views;
- favorites;
- conversion;
- sales;
- top listings.

---

## 22. Admin Experience

Admin remains the control center for:
- applications;
- invite codes;
- users;
- vendors;
- vendor staff;
- products;
- listings;
- categories;
- brands;
- media;
- badges;
- campaigns;
- collections;
- homepage/CMS;
- purchase limits;
- catalog compliance;
- orders;
- payments when enabled;
- audit logs;
- feature flags;
- moderation.

Suggested listing states:
- draft;
- pending_review;
- approved;
- active;
- rejected;
- suspended;
- archived.

Vendor-created listings should not automatically activate unless CloudMarket later chooses a deliberate auto-approval policy.

---

## 23. Media Architecture

Requirements:
- authenticated uploads;
- admin/vendor permission checks;
- file-type allowlist;
- size limits;
- server-side validation/finalization;
- storage key;
- MIME type;
- dimensions;
- byte size;
- image/video kind;
- alt text;
- title;
- focal point;
- archive/replace workflow;
- audit events.

Product media must support:
- one primary image;
- ordered gallery;
- optional video;
- alt-text override;
- caption.

Never create production media rows pointing to developer-local files.

---

## 24. Search & Filtering

Core filters:
- category;
- brand;
- vendor;
- strain;
- price;
- new arrival;
- featured;
- in stock;
- listing type;
- jurisdiction/location where applicable.

Strain UI must display:
- Indica
- Sativa
- Hybrid
- Hybrid I
- Hybrid S
- CBD

Future filters:
- effects;
- flavors;
- genetics;
- terpene data;
- saved searches.

---

## 25. Cart, Checkout & Payments

### Current rule
Checkout remains disabled until business, licensing, compliance, fulfillment, and payment requirements are explicitly satisfied.

### Feature gates
At minimum:
- checkout enabled;
- pickup enabled;
- delivery enabled;
- crypto enabled;
- auctions enabled;
- vendor self-publish enabled;
- mobile transactions enabled.

### Crypto
CloudMarket may support crypto later. It must remain separately feature-gated and must not turn on just because payment tables/code exist.

---

## 26. Compliance Design

The platform should be capable of supporting:
- age/eligibility controls;
- jurisdiction gating;
- vendor/license verification;
- purchase limits;
- inventory reservation;
- compliance classification;
- required product metadata;
- audit history;
- fulfillment restrictions;
- taxes/fees where applicable;
- jurisdiction-specific shutdown flags.

No developer should assume interstate shipping, pickup, delivery, auctions, or mobile transaction flows are permissible merely because the software supports them.

Obtain jurisdiction-specific legal/compliance review before enabling regulated commerce.

---

## 27. Mobile App Requirements

CloudMarket requires both:
- iOS app;
- Android app.

Mobile and web must share:
- accounts;
- roles;
- invite/application state;
- vendors;
- products;
- listings;
- favorites/watchlist;
- carts/orders where enabled;
- notifications;
- feature flags;
- compliance rules;
- backend business logic.

Do not create a separate mobile-only database.

### Suggested shopper bottom navigation
1. Home
2. Market
3. Favorites/Watch
4. Bag
5. Account

Vendor role exposes a vendor/dashboard entry.

### Required mobile screens
- splash;
- landing/gate;
- invite redemption;
- shopper application;
- vendor application;
- sign in;
- application status;
- marketplace home;
- search;
- category;
- product;
- vendor storefront;
- favorites/watchlist;
- bag;
- orders;
- account;
- notifications;
- vendor dashboard screens.

### App-store capability gating
Mobile clients must allow regulated transaction features to be disabled independently if required for distribution/review, while preserving membership, account, application, discovery, and other permitted functionality.

---

## 28. Mobile Visual Direction

### Splash
- dark smoke background;
- pearl cloud;
- flame accent;
- compact CloudMarket mark;
- subtle mascot/cart entrance.

### Mobile header
- compact logo;
- cloud/smoke line;
- search;
- notifications;
- account avatar.

### Cards
Use the same cloud/fire language as web, simplified for small screens.

---

## 29. Notifications

Categories:
- application submitted;
- needs information;
- approved/rejected;
- invite accepted;
- security/account;
- listing status;
- favorite/watch changes;
- order status;
- vendor order;
- inventory warning;
- auction events when enabled.

Channels may include in-app, email, and mobile push.

Avoid unnecessary sensitive details in notification previews.

---

## 30. Design System Components

Create reusable components:
- CloudButton
- CloudCard
- FireCloudCard
- ProductCard
- VendorCard
- Badge
- StatusBadge
- SearchBar
- FilterDrawer
- AppHeader
- PublicGateHeader
- MobileBottomNav
- Modal/Sheet
- FormField
- ApplicationStepper
- InviteCodeInput
- EmptyStateMascot
- LoadingCloud
- Toast
- ConfirmationDialog
- MediaGallery
- VendorHeader
- MarketplaceSection
- FloatingCloudBackground

Do not hardcode the brand separately on every page.

---

## 31. Accessibility

Requirements:
- sufficient contrast;
- semantic headings;
- visible focus states;
- keyboard navigation on web;
- screen-reader labels;
- accessible forms/errors;
- alt text;
- reduced-motion support;
- adequate touch targets;
- no information communicated only with color;
- decorative backgrounds hidden from assistive technology.

Permanent Marker must never be the only font used for critical information.

---

## 32. Performance

The site may be visually rich but must not feel heavy.

Rules:
- lazy-load noncritical imagery;
- optimize product media;
- avoid huge autoplay background video as the default hero mechanism;
- prefer layered/vector/raster animation where practical;
- defer noncritical motion;
- keep the public gate responsive;
- maintain usability on slower mobile devices;
- animation must never delay auth/navigation.

Mascot animation is an enhancement, not a dependency.

---

## 33. Security

Minimum requirements:
- role-based authorization enforced server-side;
- never trust client role checks;
- audit privileged actions;
- secure sessions;
- rate-limit auth/invite/application endpoints;
- protect admin/vendor mutations;
- validate uploads;
- restrict storage operations;
- no secrets in browser bundles;
- separate owner/admin/vendor/shopper privileges;
- log relevant permission failures;
- enforce feature flags server-side;
- do not expose private catalog through unauthenticated APIs.

The public/private boundary must be enforced on the server, not merely hidden in navigation.

---

## 34. Data Model Additions

Extend the existing schema rather than replacing it.

### `vendors`
Conceptual fields:
- id;
- slug;
- display name;
- legal name nullable;
- description;
- logo/hero media;
- status;
- jurisdiction;
- compliance/license fields where applicable;
- timestamps.

### `vendor_memberships`
- vendor id;
- user id;
- role;
- status;
- invited by;
- timestamps.

### `shopper_applications`
- applicant/user linkage;
- status;
- jurisdiction;
- submitted data;
- reviewer;
- notes;
- timestamps.

### `vendor_applications`
- applicant/user linkage;
- proposed vendor data;
- status;
- reviewer;
- notes;
- timestamps.

### `vendor_listings`
- vendor id;
- product id;
- listing type;
- status;
- vendor SKU;
- price;
- inventory;
- measurement/size;
- start/end;
- fulfillment flags;
- timestamps.

### Favorites/watchlist
- user id;
- product/listing id;
- timestamps.

### Auction bids
Only when auctions are enabled.

Every database change gets a new Drizzle migration. Never manually alter production without reconciling migration history.

---

## 35. Backend/API Principles

Business rules belong in shared server logic so web and mobile cannot disagree.

Backend owns:
- authorization;
- application approval;
- invite validation;
- vendor permissions;
- listing moderation;
- inventory rules;
- purchase limits;
- order creation;
- payment state;
- auction validity;
- media finalization;
- audit events.

Web and mobile are clients of the same rules.

---

## 36. Audit Requirements

Audit at minimum:
- invite create/revoke/redeem;
- application submit/review/approve/reject;
- vendor create/suspend;
- vendor membership changes;
- listing create/approve/suspend;
- catalog compliance changes;
- media upload/replace/archive;
- admin permission changes;
- checkout/payment feature changes;
- purchase-limit changes;
- payment actions;
- relevant security failures.

Audit records should include actor, action, entity type/id, timestamp, and safe metadata. Never store secrets in audit logs.

---

## 37. Feature Flags

Recommended explicit flags:
- marketplace_public = false
- shopper_applications_enabled
- vendor_applications_enabled
- invite_registration_enabled
- vendor_self_publish_enabled
- checkout_enabled
- pickup_enabled
- delivery_enabled
- crypto_payments_enabled
- auctions_enabled
- mobile_transactions_enabled

Flags must be enforced server-side.

---

## 38. Content Voice

Copy should be:
- concise;
- confident;
- gritty;
- hip-hop influenced;
- premium;
- not childish;
- not overloaded with slang.

Good CTA direction:
- **Tap In**
- **Apply to Shop**
- **Apply to Vend**
- **Enter Invite Code**
- **Enter the Market**
- **View Drop**
- **Watch Item**

Legal/compliance messaging should remain plain and professional.

---

## 39. Implementation Phases

### Phase A — Creative system
Deliver:
- final logo;
- compact logo;
- app icon;
- mascot;
- palette;
- typography;
- cloud/fire card frame;
- backgrounds;
- motion storyboard.

### Phase B — Access architecture
Deliver:
- public gate;
- shopper application;
- vendor application;
- invite redemption;
- approval flows;
- role model;
- server-side marketplace gate.

### Phase C — Marketplace foundation
Deliver:
- vendors;
- vendor memberships;
- listings;
- vendor storefront;
- private marketplace home;
- search/filter;
- favorites/watchlist.

### Phase D — Product/media
Deliver:
- authenticated media upload/finalization;
- product gallery;
- vendor media;
- initial RedBeards draft catalog import;
- listing creation workflow.

### Phase E — Vendor tools
Deliver:
- dashboard;
- listings;
- inventory;
- team;
- orders;
- analytics foundation.

### Phase F — Transactions
Only after operational/compliance approval:
- checkout;
- permitted fulfillment modes;
- order flow;
- payment integration;
- taxes/fees;
- purchase-limit enforcement.

### Phase G — Mobile apps
Deliver:
- iOS;
- Android;
- push notifications;
- shared accounts/marketplace state;
- feature-gated transaction capability.

### Phase H — Auctions
Only if intentionally approved:
- auction listings;
- bidding;
- watch/outbid notifications;
- closing logic;
- audit trail.

---

## 40. Immediate Development Order From Current State

Do not begin by randomly restyling individual pages.

Recommended sequence:

1. Freeze this specification as product direction.
2. Produce and approve CloudMarket logo + mascot art.
3. Build reusable design tokens/components.
4. Implement the public gate with the approved visual system.
5. Safely integrate the existing Phase 5 private/invite architecture.
6. Add shopper/vendor application models and admin review.
7. Add vendor/vendor-membership/listing schema through new migrations.
8. Implement private marketplace routes and permission boundaries.
9. Finish authenticated media upload/finalization.
10. Import the 15 RedBeards products as drafts with verified media.
11. Build vendor storefront/listing UI.
12. Build mobile clients against the same backend contracts.
13. Keep checkout, crypto, and auctions disabled until explicitly approved.

---

## 41. Definition of Done — Brand/UX

Not complete until:
- logo matches the gritty cloud-on-fire/cart/mascot concept;
- UI does not look like generic SaaS;
- Cloud 9 motion is visible but not distracting;
- public landing clearly exposes Shopper, Vendor, Invite, Sign In paths;
- unauthorized users cannot access marketplace content;
- product cards use the cloud/fire comic language;
- Permanent Marker-style type appears in display/brand roles;
- body/data text remains readable;
- responsive/mobile layouts preserve identity;
- reduced-motion mode works;
- app icon/mobile UI match the same brand.

---

## 42. Definition of Done — Marketplace

Marketplace MVP is not complete until:
- shopper application works;
- vendor application works;
- invite codes work;
- admin can approve/reject;
- unauthorized users cannot access marketplace content;
- vendor entities are separate from platform admins;
- vendor listings are separate from canonical products;
- vendor storefront works;
- search/filter works;
- product detail works;
- favorites/watchlist works;
- media uploads are authenticated/validated;
- privileged workflows are audited;
- regulated transaction features remain gated.

---

## 43. Definition of Done — Mobile

Not complete until:
- iOS and Android share the same account system;
- invite/application flows work;
- marketplace access rules match web;
- product/vendor discovery works;
- favorites/watchlist sync;
- account/security works;
- notification foundation works;
- feature flags are respected;
- branded splash/icon are approved;
- accessibility/reduced motion are addressed;
- mobile cannot bypass backend authorization/compliance rules.

---

## 44. Critical Instructions to Claude / Developers

1. Do not reset, drop, reseed, or replace the production database.
2. Use additive Drizzle migrations.
3. Preserve migration history through `0018`.
4. Do not enable checkout automatically.
5. Do not enable crypto automatically.
6. Do not expose the private catalog to guests.
7. Do not rely on client-side gating alone.
8. Do not make vendors platform admins.
9. Do not overload `products` as vendor/listing ownership.
10. Add explicit vendor and listing entities.
11. Keep media inside the approved media subsystem.
12. Do not point production media rows to local files.
13. Keep raw enum values out of user-facing copy.
14. Preserve Hybrid I and Hybrid S.
15. Do not invent THC, CBD, pricing, inventory, licensing, or lab data.
16. Do not publish imported RedBeards products until required data is verified.
17. Keep compliance-sensitive features behind server-enforced flags.
18. Build reusable design components/tokens instead of hardcoding pages.
19. Honor reduced motion/accessibility.
20. Web and mobile use the same backend business rules.
21. Do not ship Phase 5 code wholesale without reviewing migrations, environment requirements, flags, and deployment impact.
22. At production thresholds, stop and verify target database, migration state, build, and deployment commit before proceeding.

---

## 45. Developer Handoff Summary

CloudMarket should become a **private, membership-gated, multi-vendor marketplace wrapped in an original gritty hip-hop comic Cloud 9 universe**.

It has two equally important requirements:

### Operationally serious marketplace architecture
Strong permissions, application approval, vendor separation, audit logs, compliance gates, inventory/listing structure, secure media, and shared web/mobile backend rules.

### Unmistakable branded experience
A cloud on fire, cannabis bud mascot pushing a cart, smoke, pearl whites, dark charcoal, yellow/red energy, Permanent Marker headlines, animated Cloud 9 movement, and fiery cloud product cards.

Do not sacrifice one side for the other. The correct CloudMarket implementation is both a serious marketplace platform and a highly recognizable branded world.
