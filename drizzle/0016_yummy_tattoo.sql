CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "kind" "media_kind" DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "bytes" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "duration_seconds" numeric(9, 3);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN "alt_text_override" varchar(255);--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN "caption" varchar(320);--> statement-breakpoint
ALTER TABLE "product_media" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;