CREATE TYPE "public"."payment_intent_method" AS ENUM('crypto');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('pending', 'awaiting_payment', 'partially_paid', 'paid', 'overpaid', 'expired', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('mock', 'btcpay', 'coinbase_commerce');--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'BACKUP_ADMIN_ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'BACKUP_ADMIN_REMOVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'ADMIN_ACCESS_DENIED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'OWNER_IDENTITY_MISCONFIGURED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVITE_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVITE_DEACTIVATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVITE_REDEEMED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'INVITE_REDEMPTION_FAILED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_INTENT_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_INTENT_CONFIRMED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_INTENT_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_INTENT_FAILED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_WEBHOOK_REJECTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_REFUND_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_REFUND_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PAYMENT_CONFIG_CHANGED';--> statement-breakpoint
CREATE TABLE "admin_backup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" integer DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_backup_slot_is_one" CHECK ("admin_backup"."slot" = 1)
);
--> statement-breakpoint
CREATE TABLE "invite_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_prefix" varchar(12) NOT NULL,
	"label" varchar(120),
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_max_uses_positive" CHECK ("invite_codes"."max_uses" >= 1),
	CONSTRAINT "invite_codes_use_count_within_budget" CHECK ("invite_codes"."use_count" >= 0 and "invite_codes"."use_count" <= "invite_codes"."max_uses")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_intent_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_event_id" varchar(200) NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejection_reason" varchar(120),
	"provider_timestamp" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_intent_method" DEFAULT 'crypto' NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"status" "payment_intent_status" DEFAULT 'pending' NOT NULL,
	"provider_reference" varchar(200),
	"fiat_amount_cents" integer NOT NULL,
	"fiat_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"crypto_currency" varchar(12),
	"crypto_network" varchar(40),
	"crypto_amount_quoted" numeric(38, 18),
	"crypto_amount_received" numeric(38, 18),
	"exchange_rate" numeric(38, 18),
	"payment_address" varchar(200),
	"quote_created_at" timestamp with time zone,
	"quote_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refunded_by" uuid,
	"failure_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_fiat_amount_positive" CHECK ("payment_intents"."fiat_amount_cents" > 0),
	CONSTRAINT "payment_intents_confirmed_implies_settled" CHECK ("payment_intents"."confirmed_at" is null or "payment_intents"."status" in ('paid', 'overpaid', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "admin_backup" ADD CONSTRAINT "admin_backup_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_backup" ADD CONSTRAINT "admin_backup_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_backup" ADD CONSTRAINT "admin_backup_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_refunded_by_users_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_backup_single_active_slot" ON "admin_backup" USING btree ("slot") WHERE "admin_backup"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_backup_active_user_unique" ON "admin_backup" USING btree ("user_id") WHERE "admin_backup"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "admin_backup_user_idx" ON "admin_backup" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_redemptions_user_unique" ON "invite_code_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invite_code_redemptions_invite_idx" ON "invite_code_redemptions" USING btree ("invite_code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_code_hash_unique" ON "invite_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "invite_codes_created_by_idx" ON "invite_codes" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invite_codes_created_at_idx" ON "invite_codes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_intent_idx" ON "payment_events" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "payment_events_received_idx" ON "payment_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "payment_intents_order_idx" ON "payment_intents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_intents_status_idx" ON "payment_intents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_provider_reference_unique" ON "payment_intents" USING btree ("provider","provider_reference") WHERE "payment_intents"."provider_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_one_live_per_order" ON "payment_intents" USING btree ("order_id") WHERE "payment_intents"."status" in ('pending', 'awaiting_payment', 'partially_paid');--> statement-breakpoint
-- ===========================================================================
-- DEFENCE IN DEPTH: AT MOST TWO ADMINISTRATORS
-- ===========================================================================
--
-- Everything above this line is generated. Everything below is hand-written,
-- because it expresses invariants Drizzle has no vocabulary for.
--
-- WHAT ACTUALLY ENFORCES "NEVER A THIRD ADMINISTRATOR"
--
-- Not this trigger. The real mechanism is structural and lives in two places:
--
--   1. The OWNER is the `CLOUDMARKET_OWNER_USER_ID` environment variable. It is
--      not a row, so no database write can create, move or duplicate it.
--   2. The BACKUP is the single live row permitted by
--      `admin_backup_single_active_slot` — a partial unique index over a
--      CHECK-pinned constant column, so a second live row is arithmetically
--      impossible rather than merely disallowed.
--
-- `requireAdminIdentity()` grants access on those two facts alone and never on
-- `users.role`, so a table full of accounts marked `admin` would still yield
-- exactly zero additional administrators.
--
-- WHAT THIS TRIGGER IS FOR, THEN
--
-- Hygiene and early warning. `users.role = 'admin'` is what a person reads when
-- they run a query against the user table, and an account carrying it that
-- cannot actually administer anything is a misleading artefact — the sort that
-- makes an incident review harder, or convinces someone the identity model is
-- not working. This makes the column unable to drift far from the truth, and
-- makes the attempt fail loudly at the point it is made rather than silently
-- leaving a lie behind.
--
-- THE ADVISORY LOCK IS NOT DECORATION. Without it, two concurrent promotions
-- both count one existing administrator, both pass, and the table ends up with
-- three. A transaction-scoped advisory lock on a fixed key serialises the only
-- operation that can violate the count, and it is released automatically at
-- commit or rollback. It costs nothing in normal operation because the trigger
-- body only runs when a role is actually being set to `admin` — which happens
-- when the owner fills the backup slot, and at no other time.
--
-- SOFT-DELETED ACCOUNTS ARE EXCLUDED from the count. A deleted administrator is
-- not administering anything, and counting them would make the slot
-- permanently unfillable after one removal-by-deletion.
CREATE OR REPLACE FUNCTION cloudmarket_enforce_max_two_admins()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  live_admins integer;
BEGIN
  -- Only promotions can breach the ceiling. Demotions and unrelated column
  -- updates return immediately, so this costs nothing on ordinary writes.
  IF NEW.role <> 'admin' THEN
    RETURN NEW;
  END IF;

  -- Already an administrator: this UPDATE cannot change the count.
  IF TG_OP = 'UPDATE' AND OLD.role = 'admin' THEN
    RETURN NEW;
  END IF;

  -- Serialise concurrent promotions. Held until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('cloudmarket_admin_ceiling'));

  SELECT count(*) INTO live_admins
  FROM users
  WHERE role = 'admin' AND deleted_at IS NULL;

  IF live_admins >= 2 THEN
    RAISE EXCEPTION
      'CloudMarket permits at most two administrators (owner + one backup); found %', live_admins
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
-- `UPDATE OF role` rather than a bare UPDATE: the trigger is irrelevant to a
-- customer changing their name, and firing on every user write would put a
-- plpgsql call on a hot path for no benefit.
DROP TRIGGER IF EXISTS users_max_two_admins ON users;--> statement-breakpoint
CREATE TRIGGER users_max_two_admins
BEFORE INSERT OR UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION cloudmarket_enforce_max_two_admins();--> statement-breakpoint
-- ===========================================================================
-- RATE-LIMIT SUPPORTING INDEX
-- ===========================================================================
--
-- `lib/security/rate-limit.ts` counts rows in `audit_log` by (ip_hash, event,
-- occurred_at) — deliberately reusing data the application already writes
-- instead of introducing a rate-limit table, which is the same approach
-- `checkSendThrottle` and `reauthenticate` already take.
--
-- The existing indexes are single-column (`event`, `occurred_at`, `user_id`),
-- and none of them answers that question well: filtering by `event` alone on a
-- busy log scans every FAILED_LOGIN ever recorded. This composite matches the
-- WHERE clause exactly, in its selectivity order — `ip_hash` first because it
-- is by far the most selective term, then `event`, then the time range as the
-- ordered trailing column.
--
-- PARTIAL, on `ip_hash IS NOT NULL`. Audit rows written outside a request scope
-- (jobs, scripts, the sweeper) have no origin and can never match a rate-limit
-- query, so indexing them would grow the index without ever being read.
CREATE INDEX IF NOT EXISTS "audit_log_rate_limit_idx"
ON "audit_log" USING btree ("ip_hash", "event", "occurred_at")
WHERE "ip_hash" IS NOT NULL;
