DROP INDEX IF EXISTS "registry_assets_manifest_idx";--> statement-breakpoint
ALTER TABLE "registry_assets" DROP COLUMN IF EXISTS "oci_manifest_id";
