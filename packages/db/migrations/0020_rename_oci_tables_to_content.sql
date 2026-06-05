ALTER TABLE IF EXISTS "oci_manifests" RENAME TO "content_manifests";--> statement-breakpoint
ALTER TABLE IF EXISTS "oci_tags" RENAME TO "content_tags";--> statement-breakpoint
ALTER TABLE IF EXISTS "oci_manifest_blob_refs" RENAME TO "content_blob_refs";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifests_repo_digest_uq" RENAME TO "content_manifests_repo_digest_uq";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifests_subject_idx" RENAME TO "content_manifests_subject_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_tags_pkg_tag_uq" RENAME TO "content_tags_pkg_tag_uq";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_tags_repo_idx" RENAME TO "content_tags_repo_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_tags_manifest_idx" RENAME TO "content_tags_manifest_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifest_blob_refs_pkg_manifest_blob_uq" RENAME TO "content_blob_refs_pkg_manifest_blob_uq";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifest_blob_refs_pkg_blob_idx" RENAME TO "content_blob_refs_pkg_blob_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifest_blob_refs_repo_blob_idx" RENAME TO "content_blob_refs_repo_blob_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "oci_manifest_blob_refs_manifest_idx" RENAME TO "content_blob_refs_manifest_idx";
