CREATE TYPE "public"."cart_status" AS ENUM('active', 'merged', 'converted', 'abandoned');--> statement-breakpoint
CREATE TABLE "cart_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_token_hash" varchar(64),
	"user_id" uuid,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"merged_into_cart_id" uuid,
	"merged_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_lines_cart_variant_unique" ON "cart_lines" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "cart_lines_cart_id_idx" ON "cart_lines" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "cart_lines_variant_id_idx" ON "cart_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_guest_token_hash_unique" ON "carts" USING btree ("guest_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_one_active_per_user" ON "carts" USING btree ("user_id") WHERE "carts"."status" = 'active' and "carts"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "carts_user_id_idx" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "carts_status_idx" ON "carts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "carts_last_activity_idx" ON "carts" USING btree ("last_activity_at");--> statement-breakpoint
-- Quantity is a positive integer. Zero is not a quantity: removing an item
-- deletes the line, so a zero row must never be able to linger and render as
-- an empty entry. Enforced by the database rather than by application care.
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_quantity_positive" CHECK ("quantity" > 0);
