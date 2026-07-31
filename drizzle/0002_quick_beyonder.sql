CREATE TYPE "public"."audit_event" AS ENUM('ACCOUNT_CREATED', 'LOGIN', 'LOGOUT', 'FAILED_LOGIN', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'SESSION_REVOKED', 'ACCOUNT_SUSPENDED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" "audit_event" NOT NULL,
	"user_id" uuid,
	"session_id" uuid,
	"ip_hash" varchar(64),
	"user_agent_hash" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_idx" ON "audit_log" USING btree ("event");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");