DROP INDEX IF EXISTS "repositories_format_idx";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "format" TO "module_id";--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "module_id" TYPE text USING "module_id"::text;--> statement-breakpoint
CREATE INDEX "repositories_module_id_idx" ON "repositories" USING btree ("module_id");--> statement-breakpoint
ALTER TABLE "blob_refs" ALTER COLUMN "kind" TYPE text USING "kind"::text;--> statement-breakpoint
DROP TYPE IF EXISTS "package_format";--> statement-breakpoint
DROP TYPE IF EXISTS "blob_ref_kind";
