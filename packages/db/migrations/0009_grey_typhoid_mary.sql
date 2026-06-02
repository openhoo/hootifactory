CREATE INDEX "oidc_providers_org_idx" ON "oidc_providers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "role_bindings_repository_idx" ON "role_bindings" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "virtual_repo_members_member_idx" ON "virtual_repo_members" USING btree ("member_repo_id");--> statement-breakpoint
CREATE INDEX "vex_annotations_finding_idx" ON "vex_annotations" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "oci_tags_repo_idx" ON "oci_tags" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "oci_tags_manifest_idx" ON "oci_tags" USING btree ("manifest_id");