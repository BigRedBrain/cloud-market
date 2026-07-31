CREATE TYPE "public"."license_type" AS ENUM('adult_use_retailer', 'medical_provisioning_center', 'both');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"status" "store_status" DEFAULT 'active' NOT NULL,
	"license_type" "license_type" NOT NULL,
	"license_number" varchar(64) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"address_line1" varchar(255) NOT NULL,
	"address_line2" varchar(255),
	"city" varchar(120) NOT NULL,
	"state" varchar(2) DEFAULT 'MI' NOT NULL,
	"postal_code" varchar(10) NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"timezone" varchar(64) DEFAULT 'America/Detroit' NOT NULL,
	"delivery_enabled" boolean DEFAULT true NOT NULL,
	"pickup_enabled" boolean DEFAULT true NOT NULL,
	"delivery_radius_meters" integer,
	"delivery_fee_cents" integer DEFAULT 0 NOT NULL,
	"minimum_order_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stores_slug_unique" ON "stores" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_license_number_unique" ON "stores" USING btree ("license_number");--> statement-breakpoint
CREATE INDEX "stores_status_idx" ON "stores" USING btree ("status");