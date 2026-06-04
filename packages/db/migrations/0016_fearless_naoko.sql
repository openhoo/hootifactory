CREATE TABLE "oci_manifest_blob_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"blob_digest" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oci_manifest_blob_refs" ADD CONSTRAINT "oci_manifest_blob_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_manifest_blob_refs" ADD CONSTRAINT "oci_manifest_blob_refs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_manifest_blob_refs" ADD CONSTRAINT "oci_manifest_blob_refs_manifest_id_oci_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."oci_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oci_manifest_blob_refs_pkg_manifest_blob_uq" ON "oci_manifest_blob_refs" USING btree ("package_id","manifest_id","blob_digest");--> statement-breakpoint
CREATE INDEX "oci_manifest_blob_refs_pkg_blob_idx" ON "oci_manifest_blob_refs" USING btree ("package_id","blob_digest");--> statement-breakpoint
CREATE INDEX "oci_manifest_blob_refs_repo_blob_idx" ON "oci_manifest_blob_refs" USING btree ("repository_id","blob_digest");--> statement-breakpoint
CREATE INDEX "oci_manifest_blob_refs_manifest_idx" ON "oci_manifest_blob_refs" USING btree ("manifest_id");--> statement-breakpoint
WITH "live_manifest_packages" AS (
	SELECT DISTINCT
		"oci_tags"."repository_id",
		"oci_tags"."package_id",
		"oci_tags"."manifest_id"
	FROM "oci_tags"
	UNION
	SELECT DISTINCT
		"oci_manifests"."repository_id",
		"package_versions"."package_id",
		"oci_manifests"."id" AS "manifest_id"
	FROM "package_versions"
	INNER JOIN "packages" ON "packages"."id" = "package_versions"."package_id"
	INNER JOIN "oci_manifests" ON
		"oci_manifests"."repository_id" = "packages"."repository_id" AND
		"oci_manifests"."digest" = COALESCE("package_versions"."metadata" ->> 'digest', "package_versions"."version")
	WHERE "package_versions"."deleted_at" IS NULL
),
"manifest_blob_digests" AS (
	SELECT
		"live_manifest_packages"."repository_id",
		"live_manifest_packages"."package_id",
		"live_manifest_packages"."manifest_id",
		"refs"."blob_digest"
	FROM "live_manifest_packages"
	INNER JOIN "oci_manifests" ON "oci_manifests"."id" = "live_manifest_packages"."manifest_id"
	CROSS JOIN LATERAL (
		SELECT "oci_manifests"."raw"::jsonb #>> '{config,digest}' AS "blob_digest"
		UNION ALL
		SELECT "layer"."value" ->> 'digest'
		FROM jsonb_array_elements(
			CASE
				WHEN jsonb_typeof("oci_manifests"."raw"::jsonb -> 'layers') = 'array'
					THEN "oci_manifests"."raw"::jsonb -> 'layers'
				ELSE '[]'::jsonb
			END
		) AS "layer"("value")
		UNION ALL
		SELECT "blob"."value" ->> 'digest'
		FROM jsonb_array_elements(
			CASE
				WHEN jsonb_typeof("oci_manifests"."raw"::jsonb -> 'blobs') = 'array'
					THEN "oci_manifests"."raw"::jsonb -> 'blobs'
				ELSE '[]'::jsonb
			END
		) AS "blob"("value")
	) AS "refs"
	WHERE "refs"."blob_digest" IS NOT NULL AND "refs"."blob_digest" <> ''
)
INSERT INTO "oci_manifest_blob_refs" (
	"repository_id",
	"package_id",
	"manifest_id",
	"blob_digest"
)
SELECT DISTINCT
	"repository_id",
	"package_id",
	"manifest_id",
	"blob_digest"
FROM "manifest_blob_digests"
ON CONFLICT DO NOTHING;
