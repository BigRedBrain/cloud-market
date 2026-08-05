CREATE TYPE "public"."cannabis_class" AS ENUM('flower', 'concentrate', 'edible', 'other');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_type" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."inventory_state" AS ENUM('reserved', 'committed', 'released');--> statement-breakpoint
CREATE TYPE "public"."order_actor_type" AS ENUM('customer', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."order_event_type" AS ENUM('DRAFT_CREATED', 'INVENTORY_RESERVED', 'INVENTORY_COMMITTED', 'INVENTORY_RELEASED', 'ORDER_PLACED', 'ORDER_PREPARING', 'ORDER_READY', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'DRAFT_EXPIRED', 'PAYMENT_RECORDED', 'PAYMENT_COLLECTED', 'AGE_VERIFIED_AT_HANDOFF', 'COMPLIANCE_BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'placed', 'preparing', 'ready', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'ach', 'debit', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('awaiting_collection', 'collected', 'failed', 'refunded', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'ORDER_PLACED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'ORDER_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'ORDER_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_RECORDED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_COLLECTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVENTORY_RESERVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVENTORY_COMMITTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVENTORY_RELEASED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PURCHASE_LIMIT_BLOCKED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'AGE_VERIFIED_AT_HANDOFF';--> statement-breakpoint
CREATE TABLE "fulfilments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "fulfilment_type" DEFAULT 'pickup' NOT NULL,
	"store_id" uuid NOT NULL,
	"handed_off_at" timestamp with time zone,
	"handed_off_by" uuid,
	"recipient_id_checked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_type" "order_event_type" NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"actor_type" "order_actor_type" NOT NULL,
	"actor_id" uuid,
	"reason" varchar(300),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"sku" varchar(64) NOT NULL,
	"product_name" varchar(200) NOT NULL,
	"variant_label" varchar(80) NOT NULL,
	"category_name" varchar(120),
	"brand_name" varchar(120),
	"unit_price_cents" integer NOT NULL,
	"line_subtotal_cents" integer NOT NULL,
	"line_excise_tax_cents" integer DEFAULT 0 NOT NULL,
	"line_sales_tax_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer NOT NULL,
	"cannabis_class" "cannabis_class" DEFAULT 'other' NOT NULL,
	"unit_weight_grams" numeric(10, 3),
	"thc_percent" numeric(5, 2),
	"cbd_percent" numeric(5, 2),
	"equivalent_grams" numeric(10, 3) DEFAULT '0' NOT NULL,
	"concentrate_grams" numeric(10, 3) DEFAULT '0' NOT NULL,
	"equivalent_factor_applied" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(20) NOT NULL,
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"current_status" "order_status" DEFAULT 'draft' NOT NULL,
	"fulfilment_type" "fulfilment_type" DEFAULT 'pickup' NOT NULL,
	"inventory_state" "inventory_state" DEFAULT 'reserved' NOT NULL,
	"reserved_until" timestamp with time zone,
	"idempotency_key" varchar(64),
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"excise_tax_cents" integer DEFAULT 0 NOT NULL,
	"sales_tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"excise_tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"sales_tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"customer_email" varchar(255) NOT NULL,
	"customer_name" varchar(120),
	"customer_phone" varchar(32),
	"date_of_birth_at_purchase" date,
	"id_verified_at" timestamp with time zone,
	"id_verified_by" uuid,
	"total_equivalent_grams" numeric(10, 3),
	"total_concentrate_grams" numeric(10, 3),
	"placed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_method" DEFAULT 'cash' NOT NULL,
	"status" "payment_status" DEFAULT 'awaiting_collection' NOT NULL,
	"amount_cents" integer NOT NULL,
	"processor_reference" varchar(200),
	"failure_code" varchar(80),
	"collected_at" timestamp with time zone,
	"collected_by" uuid,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_limit_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cannabis_class" "cannabis_class" NOT NULL,
	"equivalent_grams_per_gram" numeric(10, 4) NOT NULL,
	"daily_equivalent_grams_cap" numeric(10, 3) NOT NULL,
	"daily_concentrate_grams_cap" numeric(10, 3),
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "reserved_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "cannabis_class" "cannabis_class" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_handed_off_by_users_id_fk" FOREIGN KEY ("handed_off_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_id_verified_by_users_id_fk" FOREIGN KEY ("id_verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fulfilments_order_unique" ON "fulfilments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "fulfilments_store_id_idx" ON "fulfilments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "order_events_order_id_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_occurred_at_idx" ON "order_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "order_events_type_idx" ON "order_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_order_variant_unique" ON "order_lines" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_id_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_variant_id_idx" ON "order_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_unique" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_idempotency_unique" ON "orders" USING btree ("user_id","idempotency_key") WHERE "orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_draft_per_user" ON "orders" USING btree ("user_id") WHERE "orders"."current_status" = 'draft';--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("current_status");--> statement-breakpoint
CREATE INDEX "orders_placed_at_idx" ON "orders" USING btree ("placed_at");--> statement-breakpoint
CREATE INDEX "orders_reserved_until_idx" ON "orders" USING btree ("reserved_until");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_open_per_order" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'awaiting_collection';--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_limit_rules_active_class" ON "purchase_limit_rules" USING btree ("cannabis_class") WHERE "purchase_limit_rules"."effective_until" is null;--> statement-breakpoint
CREATE INDEX "purchase_limit_rules_class_idx" ON "purchase_limit_rules" USING btree ("cannabis_class");