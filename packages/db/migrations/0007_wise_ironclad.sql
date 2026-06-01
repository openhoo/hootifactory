CREATE INDEX "audit_log_actor_user_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_token_idx" ON "audit_log" USING btree ("actor_token_id");--> statement-breakpoint
CREATE INDEX "quotas_repository_idx" ON "quotas" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "retention_policies_repository_idx" ON "retention_policies" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "package_versions_org_idx" ON "package_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "package_versions_published_by_user_idx" ON "package_versions" USING btree ("published_by_user_id");--> statement-breakpoint
CREATE INDEX "package_versions_published_by_token_idx" ON "package_versions" USING btree ("published_by_token_id");--> statement-breakpoint
CREATE INDEX "version_tags_version_idx" ON "version_tags" USING btree ("version_id");--> statement-breakpoint
DELETE FROM "scan_policies" WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "org_id", "repository_pattern" ORDER BY "created_at" DESC, "id" DESC) AS rn
		FROM "scan_policies"
	) ranked WHERE ranked.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "scan_policies_org_pattern_uq" ON "scan_policies" USING btree ("org_id","repository_pattern");
