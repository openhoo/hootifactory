WITH "asset_ref_candidates" AS (
	SELECT
		"registry_assets"."id" AS "asset_id",
		"blob_refs"."id" AS "blob_ref_id",
		row_number() OVER (
			PARTITION BY "registry_assets"."id"
			ORDER BY "blob_refs"."created_at" DESC, "blob_refs"."id" DESC
		) AS "rank"
	FROM "registry_assets"
	INNER JOIN "blob_refs" ON
		"blob_refs"."repository_id" = "registry_assets"."repository_id" AND
		"blob_refs"."digest" = "registry_assets"."digest" AND
		"blob_refs"."scope" = "registry_assets"."scope" AND
		"blob_refs"."kind" = CASE "registry_assets"."role"
			WHEN 'oci_layer' THEN 'oci_layer'::"public"."blob_ref_kind"
			WHEN 'oci_config' THEN 'oci_config'::"public"."blob_ref_kind"
			WHEN 'oci_manifest' THEN 'oci_manifest'::"public"."blob_ref_kind"
			WHEN 'npm_tarball' THEN 'npm_tarball'::"public"."blob_ref_kind"
			WHEN 'pypi_file' THEN 'pypi_file'::"public"."blob_ref_kind"
			ELSE 'generic_file'::"public"."blob_ref_kind"
		END
	WHERE "registry_assets"."blob_ref_id" IS NULL
)
UPDATE "registry_assets"
SET
	"blob_ref_id" = "asset_ref_candidates"."blob_ref_id",
	"updated_at" = now()
FROM "asset_ref_candidates"
WHERE
	"registry_assets"."id" = "asset_ref_candidates"."asset_id" AND
	"asset_ref_candidates"."rank" = 1;
