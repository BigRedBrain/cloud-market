-- STATEMENT ORDER IS HAND-CORRECTED. DO NOT RESTORE THE GENERATED ORDER.
--
-- drizzle-kit emitted both DROP INDEX statements BEFORE the composite
-- CREATE UNIQUE INDEX below. That order leaves invite_code_redemptions with no
-- uniqueness protection at all for the span of the migration, and the row that
-- could slip in during that window is exactly the one that makes the change
-- irreversible: once a single user holds two redemptions, the old
-- invite_code_redemptions_user_unique index can never be recreated.
--
-- The new composite index is therefore created FIRST. It cannot fail while the
-- old unique(user_id) index still stands, because one row per user trivially
-- satisfies uniqueness on (invite_code_id, user_id).
--
-- Reordering is safe with respect to Drizzle's snapshot, which describes the
-- END STATE rather than statement order. Regenerating this file will reproduce
-- the unsafe order; if that happens, reorder it again.

CREATE TYPE "public"."invite_target_role" AS ENUM('shopper', 'vendor');--> statement-breakpoint
CREATE TYPE "public"."marketplace_access_status" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."marketplace_scope" AS ENUM('shopper', 'vendor');--> statement-breakpoint
CREATE TABLE "marketplace_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "marketplace_scope" NOT NULL,
	"status" "marketplace_access_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "target_role" "invite_target_role" DEFAULT 'shopper' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_access" ADD CONSTRAINT "marketplace_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_access_user_unique" ON "marketplace_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_redemptions_invite_user_unique" ON "invite_code_redemptions" USING btree ("invite_code_id","user_id");--> statement-breakpoint
DROP INDEX "invite_code_redemptions_user_unique";--> statement-breakpoint
DROP INDEX "invite_code_redemptions_invite_idx";
