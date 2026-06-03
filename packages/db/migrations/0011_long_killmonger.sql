CREATE TABLE "registry_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid,
	"package_version_id" uuid,
	"oci_manifest_id" uuid,
	"blob_ref_id" uuid,
	"digest" varchar(80) NOT NULL,
	"role" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"path" text,
	"media_type" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_package_version_id_package_versions_id_fk" FOREIGN KEY ("package_version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_oci_manifest_id_oci_manifests_id_fk" FOREIGN KEY ("oci_manifest_id") REFERENCES "public"."oci_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_blob_ref_id_blob_refs_id_fk" FOREIGN KEY ("blob_ref_id") REFERENCES "public"."blob_refs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	br."id",
	pv."metadata" #>> '{dist,blobDigest}',
	'npm_tarball',
	p."name" || '@' || pv."version",
	pv."metadata" #>> '{dist,filename}',
	'application/octet-stream',
	COALESCE(NULLIF(pv."metadata" #>> '{dist,size}', '')::bigint, pv."size_bytes"),
	jsonb_build_object(
		'shasum', pv."metadata" #>> '{dist,shasum}',
		'integrity', pv."metadata" #>> '{dist,integrity}'
	)
FROM "package_versions" pv
JOIN "packages" p ON p."id" = pv."package_id"
LEFT JOIN "blob_refs" br ON br."repository_id" = p."repository_id"
	AND br."digest" = (pv."metadata" #>> '{dist,blobDigest}')
	AND br."kind" = 'npm_tarball'
	AND br."scope" = p."name" || '@' || pv."version"
WHERE pv."metadata" #>> '{dist,blobDigest}' IS NOT NULL;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	br."id",
	file."value"->>'blobDigest',
	'pypi_file',
	file."value"->>'filename',
	file."value"->>'filename',
	'application/octet-stream',
	COALESCE(NULLIF(file."value"->>'size', '')::bigint, pv."size_bytes"),
	jsonb_build_object('filetype', file."value"->>'filetype')
FROM "package_versions" pv
JOIN "packages" p ON p."id" = pv."package_id"
JOIN LATERAL jsonb_array_elements(COALESCE(pv."metadata"->'files', '[]'::jsonb)) AS file("value") ON true
LEFT JOIN "blob_refs" br ON br."repository_id" = p."repository_id"
	AND br."digest" = (file."value"->>'blobDigest')
	AND br."kind" = 'pypi_file'
	AND br."scope" = (file."value"->>'filename')
WHERE file."value"->>'blobDigest' IS NOT NULL;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	br."id",
	pv."metadata"->>'crateDigest',
	'cargo_crate',
	p."name" || '@' || pv."version" || '.crate',
	p."name" || '-' || pv."version" || '.crate',
	'application/octet-stream',
	pv."size_bytes",
	jsonb_build_object('checksum', pv."metadata" #>> '{index,cksum}')
FROM "package_versions" pv
JOIN "packages" p ON p."id" = pv."package_id"
LEFT JOIN "blob_refs" br ON br."repository_id" = p."repository_id"
	AND br."digest" = (pv."metadata"->>'crateDigest')
	AND br."kind" = 'generic_file'
	AND br."scope" = p."name" || '@' || pv."version" || '.crate'
WHERE pv."metadata"->>'crateDigest' IS NOT NULL;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	br."id",
	pv."metadata"->>'zipDigest',
	'go_zip',
	p."name" || '@' || pv."version" || '.zip',
	pv."version" || '.zip',
	'application/zip',
	COALESCE(NULLIF(pv."metadata"->>'zipSize', '')::bigint, pv."size_bytes"),
	jsonb_build_object('module', p."name")
FROM "package_versions" pv
JOIN "packages" p ON p."id" = pv."package_id"
LEFT JOIN "blob_refs" br ON br."repository_id" = p."repository_id"
	AND br."digest" = (pv."metadata"->>'zipDigest')
	AND br."kind" = 'generic_file'
	AND br."scope" = p."name" || '@' || pv."version" || '.zip'
WHERE pv."metadata"->>'zipDigest' IS NOT NULL;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	br."id",
	pv."metadata"->>'nupkgDigest',
	'nuget_package',
	lower(p."name") || '.' || lower(pv."version") || '.nupkg',
	lower(p."name") || '.' || lower(pv."version") || '.nupkg',
	'application/octet-stream',
	pv."size_bytes",
	jsonb_build_object('id', p."name", 'version', pv."version")
FROM "package_versions" pv
JOIN "packages" p ON p."id" = pv."package_id"
LEFT JOIN "blob_refs" br ON br."repository_id" = p."repository_id"
	AND br."digest" = (pv."metadata"->>'nupkgDigest')
	AND br."kind" = 'generic_file'
	AND br."scope" = lower(p."name") || '.' || lower(pv."version") || '.nupkg'
WHERE pv."metadata"->>'nupkgDigest' IS NOT NULL;--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"blob_ref_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT
	r."org_id",
	br."repository_id",
	p."id",
	br."id",
	br."digest",
	'oci_layer',
	br."scope",
	br."scope" || '/blobs/' || br."digest",
	b."media_type",
	b."size_bytes",
	'{}'::jsonb
FROM "blob_refs" br
JOIN "repositories" r ON r."id" = br."repository_id"
LEFT JOIN "packages" p ON p."repository_id" = br."repository_id" AND p."name" = br."scope"
LEFT JOIN "blobs" b ON b."digest" = br."digest"
WHERE br."kind" = 'oci_layer';--> statement-breakpoint
INSERT INTO "registry_assets" (
	"org_id",
	"repository_id",
	"package_id",
	"package_version_id",
	"oci_manifest_id",
	"digest",
	"role",
	"scope",
	"path",
	"media_type",
	"size_bytes",
	"metadata"
)
SELECT DISTINCT ON (p."repository_id", p."name", om."digest")
	p."org_id",
	p."repository_id",
	p."id",
	pv."id",
	om."id",
	om."digest",
	'oci_manifest',
	p."name",
	p."name" || '@' || om."digest",
	om."media_type",
	om."size_bytes",
	jsonb_build_object(
		'artifactType', om."artifact_type",
		'subjectDigest', om."subject_digest",
		'configDigest', om."config_digest"
	)
FROM "oci_manifests" om
JOIN "package_versions" pv ON pv."metadata"->>'digest' = om."digest"
JOIN "packages" p ON p."id" = pv."package_id" AND p."repository_id" = om."repository_id"
ORDER BY p."repository_id", p."name", om."digest", pv."created_at" DESC;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_assets_repo_role_scope_digest_uq" ON "registry_assets" USING btree ("repository_id","role","scope","digest");--> statement-breakpoint
CREATE INDEX "registry_assets_org_idx" ON "registry_assets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "registry_assets_repo_idx" ON "registry_assets" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "registry_assets_package_idx" ON "registry_assets" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "registry_assets_version_idx" ON "registry_assets" USING btree ("package_version_id");--> statement-breakpoint
CREATE INDEX "registry_assets_digest_idx" ON "registry_assets" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "registry_assets_manifest_idx" ON "registry_assets" USING btree ("oci_manifest_id");
