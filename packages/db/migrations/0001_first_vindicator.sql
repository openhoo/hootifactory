ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_published_by_token_id_api_tokens_id_fk" FOREIGN KEY ("published_by_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_user_org_uq" ON "role_bindings" USING btree ("org_id","user_id") WHERE "role_bindings"."user_id" is not null and "role_bindings"."repository_id" is null;--> statement-breakpoint
CREATE INDEX "artifacts_repo_idx" ON "artifacts" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotas_org_uq" ON "quotas" USING btree ("org_id") WHERE "quotas"."repository_id" is null;--> statement-breakpoint
-- Single authority for blobs.ref_count decrement. Fires for both application-driven
-- blob_ref deletes and FK-cascade deletes (repo/org removal), so the count can never
-- desync. Increment stays in application code on blob_ref insert; only the decrement is
-- centralized here (no AFTER INSERT trigger, so there is no double-counting).
CREATE FUNCTION "blob_refs_after_delete"() RETURNS trigger AS $$
BEGIN
  UPDATE "blobs"
     SET "ref_count" = "ref_count" - 1,
         "state" = CASE WHEN "ref_count" - 1 <= 0 THEN 'pending_delete'::"public"."blob_state" ELSE "state" END,
         "pending_since" = CASE WHEN "ref_count" - 1 <= 0 THEN now() ELSE "pending_since" END
   WHERE "digest" = OLD."digest";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "blob_refs_after_delete_trg"
  AFTER DELETE ON "blob_refs"
  FOR EACH ROW
  EXECUTE FUNCTION "blob_refs_after_delete"();