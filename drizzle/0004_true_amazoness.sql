CREATE TYPE "public"."brand_asset_type" AS ENUM('logo', 'seasonal_artwork', 'homepage_graphic', 'marketing_asset', 'promotional_banner');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('hero', 'new_drop', 'weekend_sale', 'staff_pick', 'limited_supply', 'holiday', 'brand_collab', 'announcement');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."homepage_section_type" AS ENUM('hero', 'announcement_bar', 'featured_products', 'collections', 'categories', 'promotions');--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'CAMPAIGN_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'CAMPAIGN_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'CAMPAIGN_PUBLISHED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'CAMPAIGN_ARCHIVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'COLLECTION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'COLLECTION_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'COLLECTION_PUBLISHED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'BADGE_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'BADGE_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PRODUCT_FEATURED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PRODUCT_BADGED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'HERO_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'HOMEPAGE_SECTION_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'HOMEPAGE_SECTION_PUBLISHED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'ANNOUNCEMENT_PUBLISHED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'MEDIA_UPLOADED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'MEDIA_REPLACED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'MEDIA_ARCHIVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'BRAND_ASSET_UPDATED';--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"label" varchar(60) NOT NULL,
	"icon" varchar(16),
	"variant" varchar(20) DEFAULT 'ember' NOT NULL,
	"description" varchar(200),
	"active" boolean DEFAULT true NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "brand_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(96) NOT NULL,
	"name" varchar(120) NOT NULL,
	"asset_type" "brand_asset_type" NOT NULL,
	"media_id" uuid,
	"notes" text,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"unpublish_at" timestamp with time zone,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(96) NOT NULL,
	"type" "campaign_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"subtitle" varchar(320),
	"body" text,
	"cta_label" varchar(80),
	"cta_href" varchar(300),
	"hero_media_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"unpublish_at" timestamp with time zone,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collection_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(96) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"hero_media_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"unpublish_at" timestamp with time zone,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "homepage_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "homepage_section_type" NOT NULL,
	"name" varchar(120) NOT NULL,
	"heading" varchar(160),
	"eyebrow" varchar(80),
	"subheading" varchar(320),
	"campaign_id" uuid,
	"collection_id" uuid,
	"config" jsonb,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"unpublish_at" timestamp with time zone,
	"priority" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entity_type" varchar(40);--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "summary" varchar(300);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "title" varchar(160);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "focal_x" numeric(4, 3) DEFAULT '0.500' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "focal_y" numeric(4, 3) DEFAULT '0.500' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "replaced_by_media_id" uuid;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_hero_media_id_media_id_fk" FOREIGN KEY ("hero_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_hero_media_id_media_id_fk" FOREIGN KEY ("hero_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homepage_sections" ADD CONSTRAINT "homepage_sections_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homepage_sections" ADD CONSTRAINT "homepage_sections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_badges" ADD CONSTRAINT "product_badges_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_badges" ADD CONSTRAINT "product_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "badges_slug_unique" ON "badges" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "badges_active_idx" ON "badges" USING btree ("active");--> statement-breakpoint
CREATE INDEX "brand_assets_key_idx" ON "brand_assets" USING btree ("key");--> statement-breakpoint
CREATE INDEX "brand_assets_type_idx" ON "brand_assets" USING btree ("asset_type");--> statement-breakpoint
CREATE INDEX "brand_assets_status_idx" ON "brand_assets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_slug_unique" ON "campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "campaigns_type_idx" ON "campaigns" USING btree ("type");--> statement-breakpoint
CREATE INDEX "campaigns_type_status_priority_idx" ON "campaigns" USING btree ("type","status","priority");--> statement-breakpoint
CREATE INDEX "campaigns_window_idx" ON "campaigns" USING btree ("publish_at","unpublish_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_products_unique" ON "collection_products" USING btree ("collection_id","product_id");--> statement-breakpoint
CREATE INDEX "collection_products_collection_idx" ON "collection_products" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "collection_products_product_idx" ON "collection_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_unique" ON "collections" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "collections_status_priority_idx" ON "collections" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "homepage_sections_sort_idx" ON "homepage_sections" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "homepage_sections_status_idx" ON "homepage_sections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "homepage_sections_type_idx" ON "homepage_sections" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "product_badges_unique" ON "product_badges" USING btree ("product_id","badge_id");--> statement-breakpoint
CREATE INDEX "product_badges_product_idx" ON "product_badges" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_replaced_by_media_id_media_id_fk" FOREIGN KEY ("replaced_by_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "media_archived_at_idx" ON "media" USING btree ("archived_at");