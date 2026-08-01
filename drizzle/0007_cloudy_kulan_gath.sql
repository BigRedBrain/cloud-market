ALTER TYPE "public"."audit_event" ADD VALUE 'EMAIL_VERIFICATION_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'EMAIL_VERIFIED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'EMAIL_VERIFICATION_FAILED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PASSWORD_RESET_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PASSWORD_RESET_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'PASSWORD_RESET_FAILED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'SESSIONS_REVOKED';--> statement-breakpoint
ALTER TYPE "public"."audit_event" ADD VALUE 'EMAIL_SEND_FAILED';--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "verification_tokens_user_purpose_created_idx" ON "verification_tokens" USING btree ("user_id","purpose","created_at");