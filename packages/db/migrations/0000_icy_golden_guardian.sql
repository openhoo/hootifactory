CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "public"."artifact_state" AS ENUM('pending', 'clean', 'quarantined', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('allow', 'deny', 'success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."auth_email_token_purpose" AS ENUM('password_reset', 'oidc_link');--> statement-breakpoint
CREATE TYPE "public"."blob_state" AS ENUM('active', 'pending_delete');--> statement-breakpoint
CREATE TYPE "public"."finding_type" AS ENUM('vuln', 'license', 'secret', 'malware');--> statement-breakpoint
CREATE TYPE "public"."policy_mode" AS ENUM('audit', 'enforce');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('hosted', 'proxy', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped_dedup');--> statement-breakpoint
CREATE TYPE "public"."scan_type" AS ENUM('sbom', 'vuln', 'malware', 'license', 'secret');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'negligible', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."token_type" AS ENUM('personal', 'robot');--> statement-breakpoint
CREATE TYPE "public"."upload_state" AS ENUM('open', 'closed', 'committed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"type" "token_type" DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_by_token_id" uuid,
	"revocation_reason" text,
	"rotated_at" timestamp with time zone,
	"rotated_by_user_id" uuid,
	"rotated_by_token_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "auth_email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "auth_email_token_purpose" NOT NULL,
	"user_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "auth_throttle_buckets" (
	"bucket_hash" varchar(64) PRIMARY KEY NOT NULL,
	"scope" varchar(64) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_key" varchar(256) NOT NULL,
	"template" varchar(64) NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" varchar(320),
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"group_id" uuid,
	"token_id" uuid,
	"permission" text NOT NULL,
	"repository_id" uuid,
	"repository_pattern" text,
	"package_pattern" text,
	"artifact_pattern" text,
	"policy" text,
	"token_target" text,
	"target_token_id" uuid,
	"granted_by_user_id" uuid,
	"source" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_grants_one_subject_ck" CHECK (num_nonnulls("permission_grants"."user_id", "permission_grants"."group_id", "permission_grants"."token_id") = 1),
	CONSTRAINT "permission_grants_scoped_ck" CHECK ((
        ("permission_grants"."permission" = 'system.admin' and "permission_grants"."org_id" is null and "permission_grants"."user_id" is not null and "permission_grants"."group_id" is null and "permission_grants"."token_id" is null and "permission_grants"."repository_id" is null and "permission_grants"."repository_pattern" is null and "permission_grants"."package_pattern" is null and "permission_grants"."artifact_pattern" is null and "permission_grants"."policy" is null and "permission_grants"."token_target" is null and "permission_grants"."target_token_id" is null)
        or
        ("permission_grants"."permission" <> 'system.admin' and "permission_grants"."org_id" is not null)
      ))
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
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"module_id" text NOT NULL,
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
CREATE TABLE "scan_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
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
CREATE TABLE "blob_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" varchar(80) NOT NULL,
	"kind" text NOT NULL,
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
CREATE TABLE "content_blob_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"blob_digest" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_manifests" (
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
CREATE TABLE "content_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"manifest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_id" uuid,
	"package_version_id" uuid,
	"blob_ref_id" uuid,
	"digest" varchar(80) NOT NULL,
	"role" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"path" text,
	"media_type" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"offset_bytes" bigint DEFAULT 0 NOT NULL,
	"state" "upload_state" DEFAULT 'open' NOT NULL,
	"multipart" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" varchar(32) DEFAULT 'local' NOT NULL,
	"provider" varchar(32),
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"managed_by" varchar(32),
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
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
CREATE UNIQUE INDEX "groups_org_id_uq" ON "groups" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_uq" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_target_token_id_api_tokens_id_fk" FOREIGN KEY ("target_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_published_by_token_id_api_tokens_id_fk" FOREIGN KEY ("published_by_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tags" ADD CONSTRAINT "version_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tags" ADD CONSTRAINT "version_tags_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_upstreams" ADD CONSTRAINT "repository_upstreams_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_repo_members" ADD CONSTRAINT "virtual_repo_members_virtual_repo_id_repositories_id_fk" FOREIGN KEY ("virtual_repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_repo_members" ADD CONSTRAINT "virtual_repo_members_member_repo_id_repositories_id_fk" FOREIGN KEY ("member_repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_outbox" ADD CONSTRAINT "scan_outbox_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_policies" ADD CONSTRAINT "scan_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_digest_blobs_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."blobs"("digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_blob_refs" ADD CONSTRAINT "content_blob_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_blob_refs" ADD CONSTRAINT "content_blob_refs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_blob_refs" ADD CONSTRAINT "content_blob_refs_manifest_id_content_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."content_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_manifests" ADD CONSTRAINT "content_manifests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_manifest_id_content_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."content_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_package_version_id_package_versions_id_fk" FOREIGN KEY ("package_version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_assets" ADD CONSTRAINT "registry_assets_blob_ref_id_blob_refs_id_fk" FOREIGN KEY ("blob_ref_id") REFERENCES "public"."blob_refs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_org_group_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "public"."groups"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_org_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_prefix_idx" ON "api_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_tokens_owner_idx" ON "api_tokens" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_user_purpose_idx" ON "auth_email_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_expires_idx" ON "auth_email_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_throttle_buckets_reset_at_idx" ON "auth_throttle_buckets" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_delivery_key_uq" ON "email_deliveries" USING btree ("delivery_key");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_subject_uq" ON "external_identities" USING btree ("provider","issuer","subject");--> statement-breakpoint
CREATE INDEX "external_identities_user_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "permission_grants_org_idx" ON "permission_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "permission_grants_user_idx" ON "permission_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "permission_grants_group_idx" ON "permission_grants" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "permission_grants_token_idx" ON "permission_grants" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "permission_grants_repository_idx" ON "permission_grants" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_user_scope_uq" ON "permission_grants" USING btree ("user_id","org_id","permission","repository_id","repository_pattern","package_pattern","artifact_pattern","policy","token_target","target_token_id") NULLS NOT DISTINCT WHERE "permission_grants"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_group_scope_uq" ON "permission_grants" USING btree ("group_id","org_id","permission","repository_id","repository_pattern","package_pattern","artifact_pattern","policy","token_target","target_token_id") NULLS NOT DISTINCT WHERE "permission_grants"."group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_token_scope_uq" ON "permission_grants" USING btree ("token_id","org_id","permission","repository_id","repository_pattern","package_pattern","artifact_pattern","policy","token_target","target_token_id") NULLS NOT DISTINCT WHERE "permission_grants"."token_id" is not null;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_token_idx" ON "audit_log" USING btree ("actor_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotas_org_repo_uq" ON "quotas" USING btree ("org_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotas_org_uq" ON "quotas" USING btree ("org_id") WHERE "quotas"."repository_id" is null;--> statement-breakpoint
CREATE INDEX "quotas_repository_idx" ON "quotas" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "retention_policies_org_idx" ON "retention_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "retention_policies_repository_idx" ON "retention_policies" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_pkg_version_uq" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "package_versions_live_idx" ON "package_versions" USING btree ("package_id") WHERE "package_versions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "package_versions_live_created_idx" ON "package_versions" USING btree ("package_id","created_at","id") WHERE "package_versions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "package_versions_org_idx" ON "package_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "package_versions_published_by_user_idx" ON "package_versions" USING btree ("published_by_user_id");--> statement-breakpoint
CREATE INDEX "package_versions_published_by_token_idx" ON "package_versions" USING btree ("published_by_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_repo_name_uq" ON "packages" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "packages_org_idx" ON "packages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packages_name_idx" ON "packages" USING btree ("name");--> statement-breakpoint
CREATE INDEX "packages_name_trgm_idx" ON "packages" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "version_tags_pkg_tag_uq" ON "version_tags" USING btree ("package_id","tag");--> statement-breakpoint
CREATE INDEX "version_tags_version_idx" ON "version_tags" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_org_name_uq" ON "repositories" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_mount_path_uq" ON "repositories" USING btree ("mount_path");--> statement-breakpoint
CREATE INDEX "repositories_org_idx" ON "repositories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "repositories_module_id_idx" ON "repositories" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "repository_upstreams_repo_idx" ON "repository_upstreams" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_repo_members_uq" ON "virtual_repo_members" USING btree ("virtual_repo_id","member_repo_id");--> statement-breakpoint
CREATE INDEX "virtual_repo_members_virtual_idx" ON "virtual_repo_members" USING btree ("virtual_repo_id");--> statement-breakpoint
CREATE INDEX "virtual_repo_members_member_idx" ON "virtual_repo_members" USING btree ("member_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_org_repo_digest_uq" ON "artifacts" USING btree ("org_id","repository_id","digest");--> statement-breakpoint
CREATE INDEX "artifacts_digest_idx" ON "artifacts" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "artifacts_repo_idx" ON "artifacts" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "artifacts_state_idx" ON "artifacts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "findings_scan_idx" ON "findings" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "findings_artifact_idx" ON "findings" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "findings_severity_idx" ON "findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "findings_vuln_idx" ON "findings" USING btree ("vuln_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_outbox_artifact_uq" ON "scan_outbox" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "scan_outbox_ready_idx" ON "scan_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_policies_org_pattern_uq" ON "scan_policies" USING btree ("org_id","repository_pattern");--> statement-breakpoint
CREATE INDEX "scan_policies_org_idx" ON "scan_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_dedup_uq" ON "scans" USING btree ("artifact_id","blob_digest","scan_type","scanner","scanner_version","db_version");--> statement-breakpoint
CREATE INDEX "scans_artifact_idx" ON "scans" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blob_refs_uq" ON "blob_refs" USING btree ("kind","repository_id","scope","digest");--> statement-breakpoint
CREATE INDEX "blob_refs_digest_idx" ON "blob_refs" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "blob_refs_repo_idx" ON "blob_refs" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "blobs_gc_idx" ON "blobs" USING btree ("digest") WHERE "blobs"."ref_count" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "content_blob_refs_pkg_manifest_blob_uq" ON "content_blob_refs" USING btree ("package_id","manifest_id","blob_digest");--> statement-breakpoint
CREATE INDEX "content_blob_refs_pkg_blob_idx" ON "content_blob_refs" USING btree ("package_id","blob_digest");--> statement-breakpoint
CREATE INDEX "content_blob_refs_repo_blob_idx" ON "content_blob_refs" USING btree ("repository_id","blob_digest");--> statement-breakpoint
CREATE INDEX "content_blob_refs_manifest_idx" ON "content_blob_refs" USING btree ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_manifests_repo_digest_uq" ON "content_manifests" USING btree ("repository_id","digest");--> statement-breakpoint
CREATE INDEX "content_manifests_subject_idx" ON "content_manifests" USING btree ("repository_id","subject_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_pkg_tag_uq" ON "content_tags" USING btree ("package_id","tag");--> statement-breakpoint
CREATE INDEX "content_tags_repo_idx" ON "content_tags" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "content_tags_manifest_idx" ON "content_tags" USING btree ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_assets_repo_role_scope_digest_uq" ON "registry_assets" USING btree ("repository_id","role","scope","digest");--> statement-breakpoint
CREATE INDEX "registry_assets_org_idx" ON "registry_assets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "registry_assets_repo_idx" ON "registry_assets" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "registry_assets_package_idx" ON "registry_assets" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "registry_assets_version_idx" ON "registry_assets" USING btree ("package_version_id");--> statement-breakpoint
CREATE INDEX "registry_assets_digest_idx" ON "registry_assets" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "upload_sessions_repo_idx" ON "upload_sessions" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_group_user_uq" ON "group_memberships" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_org_user_idx" ON "group_memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_group_idx" ON "group_memberships" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_org_slug_uq" ON "groups" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "groups_org_idx" ON "groups" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_external_uq" ON "groups" USING btree ("org_id","managed_by","external_key") WHERE "groups"."managed_by" is not null and "groups"."external_key" is not null;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");
