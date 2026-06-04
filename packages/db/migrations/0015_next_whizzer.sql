CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX "packages_name_trgm_idx" ON "packages" USING gin ("name" gin_trgm_ops);
