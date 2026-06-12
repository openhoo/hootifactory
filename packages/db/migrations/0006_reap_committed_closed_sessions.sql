CREATE INDEX "upload_sessions_reaper_phase2_idx" ON "upload_sessions" USING btree ("updated_at") WHERE "upload_sessions"."state" IN ('aborted', 'committed', 'closed');
