CREATE TYPE "public"."artifact_state" AS ENUM('pending', 'clean', 'quarantined', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('allow', 'deny', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."blob_ref_kind" AS ENUM('oci_layer', 'oci_config', 'oci_manifest', 'npm_tarball', 'pypi_file', 'generic_file');--> statement-breakpoint
CREATE TYPE "public"."blob_state" AS ENUM('active', 'pending_delete');--> statement-breakpoint
CREATE TYPE "public"."finding_type" AS ENUM('vuln', 'license', 'secret', 'malware');--> statement-breakpoint
CREATE TYPE "public"."package_format" AS ENUM('npm', 'docker', 'oci', 'pypi', 'maven', 'helm', 'nuget', 'go', 'cargo', 'generic');--> statement-breakpoint
CREATE TYPE "public"."policy_mode" AS ENUM('audit', 'enforce');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('hosted', 'proxy', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."role_name" AS ENUM('viewer', 'developer', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped_dedup');--> statement-breakpoint
CREATE TYPE "public"."scan_type" AS ENUM('sbom', 'vuln', 'malware', 'license', 'secret');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'negligible', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."token_type" AS ENUM('personal', 'robot');--> statement-breakpoint
CREATE TYPE "public"."upload_state" AS ENUM('open', 'closed', 'committed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role_name" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(128) NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"username" varchar(128) NOT NULL,
	"display_name" text,
	"password_hash" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"external_idp" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"type" "token_type" DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"role" "role_name",
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"group_claim" text DEFAULT 'groups' NOT NULL,
	"group_role_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"token_id" uuid,
	"repository_id" uuid,
	"role" "role_name" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"format" "package_format" NOT NULL,
	"kind" "repo_kind" DEFAULT 'hosted' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"mount_path" varchar(512) NOT NULL,
	"storage_prefix" varchar(256) NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_upstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"url" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"cache_ttl_seconds" integer DEFAULT 3600 NOT NULL,
	"credentials" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_repo_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"virtual_repo_id" uuid NOT NULL,
	"member_repo_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"version" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"published_by_user_id" uuid,
	"published_by_token_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"name" text NOT NULL,
	"namespace" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "version_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" varchar(80) NOT NULL,
	"kind" "blob_ref_kind" NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"digest" varchar(80) PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text,
	"ref_count" integer DEFAULT 0 NOT NULL,
	"state" "blob_state" DEFAULT 'active' NOT NULL,
	"pending_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oci_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"digest" varchar(80) NOT NULL,
	"media_type" text NOT NULL,
	"artifact_type" text,
	"subject_digest" varchar(80),
	"raw" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"config_digest" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oci_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"manifest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"offset_bytes" bigint DEFAULT 0 NOT NULL,
	"state" "upload_state" DEFAULT 'open' NOT NULL,
	"multipart" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"digest" varchar(80) NOT NULL,
	"media_type" text,
	"name" text,
	"version" text,
	"state" "artifact_state" DEFAULT 'pending' NOT NULL,
	"policy_decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"type" "finding_type" NOT NULL,
	"vuln_id" text,
	"aliases" text[],
	"purl" text,
	"package_name" text,
	"package_version" text,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"cvss_score" double precision,
	"fixed_version" text,
	"title" text,
	"description" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osv_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ecosystem" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"response" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sbom_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"purl" text,
	"name" text NOT NULL,
	"version" text,
	"type" text,
	"licenses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_pattern" text DEFAULT '*' NOT NULL,
	"mode" "policy_mode" DEFAULT 'audit' NOT NULL,
	"block_on_severity" "severity",
	"block_on_malware" text DEFAULT 'true' NOT NULL,
	"deny_licenses" text[],
	"max_cvss" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scanner_db_state" (
	"scanner" text PRIMARY KEY NOT NULL,
	"db_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"blob_digest" varchar(80) NOT NULL,
	"scan_type" "scan_type" NOT NULL,
	"scanner" text NOT NULL,
	"scanner_version" text DEFAULT '' NOT NULL,
	"db_version" text DEFAULT '' NOT NULL,
	"status" "scan_status" DEFAULT 'pending' NOT NULL,
	"sbom_json" jsonb,
	"sbom_native_json" jsonb,
	"raw_result_ref" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vex_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"analysis_state" text NOT NULL,
	"justification" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"actor_token_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"result" "audit_result" NOT NULL,
	"ip" varchar(64),
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid,
	"max_storage_bytes" bigint,
	"used_storage_bytes" bigint DEFAULT 0 NOT NULL,
	"max_artifacts" bigint,
	"used_artifacts" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text DEFAULT 'delete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_upstreams" ADD CONSTRAINT "repository_upstreams_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_repo_members" ADD CONSTRAINT "virtual_repo_members_virtual_repo_id_repositories_id_fk" FOREIGN KEY ("virtual_repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_repo_members" ADD CONSTRAINT "virtual_repo_members_member_repo_id_repositories_id_fk" FOREIGN KEY ("member_repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tags" ADD CONSTRAINT "version_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tags" ADD CONSTRAINT "version_tags_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_digest_blobs_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."blobs"("digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_manifests" ADD CONSTRAINT "oci_manifests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_tags" ADD CONSTRAINT "oci_tags_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_tags" ADD CONSTRAINT "oci_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_tags" ADD CONSTRAINT "oci_tags_manifest_id_oci_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."oci_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sbom_components" ADD CONSTRAINT "sbom_components_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_policies" ADD CONSTRAINT "scan_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vex_annotations" ADD CONSTRAINT "vex_annotations_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_uq" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_prefix_idx" ON "api_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_tokens_owner_idx" ON "api_tokens" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "role_bindings_org_idx" ON "role_bindings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "role_bindings_user_idx" ON "role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_user_repo_uq" ON "role_bindings" USING btree ("org_id","user_id","repository_id") WHERE "role_bindings"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_org_name_uq" ON "repositories" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_mount_path_uq" ON "repositories" USING btree ("mount_path");--> statement-breakpoint
CREATE INDEX "repositories_org_idx" ON "repositories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "repositories_format_idx" ON "repositories" USING btree ("format");--> statement-breakpoint
CREATE INDEX "repository_upstreams_repo_idx" ON "repository_upstreams" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_repo_members_uq" ON "virtual_repo_members" USING btree ("virtual_repo_id","member_repo_id");--> statement-breakpoint
CREATE INDEX "virtual_repo_members_virtual_idx" ON "virtual_repo_members" USING btree ("virtual_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_pkg_version_uq" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "package_versions_live_idx" ON "package_versions" USING btree ("package_id") WHERE "package_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "packages_repo_name_uq" ON "packages" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "packages_org_idx" ON "packages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packages_name_idx" ON "packages" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "version_tags_pkg_tag_uq" ON "version_tags" USING btree ("package_id","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_refs_uq" ON "blob_refs" USING btree ("kind","repository_id","scope","digest");--> statement-breakpoint
CREATE INDEX "blob_refs_digest_idx" ON "blob_refs" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "blob_refs_repo_idx" ON "blob_refs" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "blobs_gc_idx" ON "blobs" USING btree ("digest") WHERE "blobs"."ref_count" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "oci_manifests_repo_digest_uq" ON "oci_manifests" USING btree ("repository_id","digest");--> statement-breakpoint
CREATE INDEX "oci_manifests_subject_idx" ON "oci_manifests" USING btree ("repository_id","subject_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "oci_tags_pkg_tag_uq" ON "oci_tags" USING btree ("package_id","tag");--> statement-breakpoint
CREATE INDEX "upload_sessions_repo_idx" ON "upload_sessions" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_org_repo_digest_uq" ON "artifacts" USING btree ("org_id","repository_id","digest");--> statement-breakpoint
CREATE INDEX "artifacts_digest_idx" ON "artifacts" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "artifacts_state_idx" ON "artifacts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "findings_scan_idx" ON "findings" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "findings_artifact_idx" ON "findings" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "findings_severity_idx" ON "findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "findings_vuln_idx" ON "findings" USING btree ("vuln_id");--> statement-breakpoint
CREATE UNIQUE INDEX "osv_cache_uq" ON "osv_cache" USING btree ("ecosystem","package_name","version");--> statement-breakpoint
CREATE INDEX "sbom_components_scan_idx" ON "sbom_components" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "scan_policies_org_idx" ON "scan_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_dedup_uq" ON "scans" USING btree ("blob_digest","scan_type","scanner","scanner_version","db_version");--> statement-breakpoint
CREATE INDEX "scans_artifact_idx" ON "scans" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "quotas_org_repo_uq" ON "quotas" USING btree ("org_id","repository_id");--> statement-breakpoint
CREATE INDEX "retention_policies_org_idx" ON "retention_policies" USING btree ("org_id");