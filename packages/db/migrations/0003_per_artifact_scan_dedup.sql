DROP INDEX "scans_dedup_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "scans_dedup_uq" ON "scans" USING btree ("artifact_id","blob_digest","scan_type","scanner","scanner_version","db_version");