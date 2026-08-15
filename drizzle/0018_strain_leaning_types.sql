ALTER TYPE "public"."strain_type"
ADD VALUE IF NOT EXISTS 'hybrid_i' BEFORE 'cbd';
--> statement-breakpoint
ALTER TYPE "public"."strain_type"
ADD VALUE IF NOT EXISTS 'hybrid_s' BEFORE 'cbd';