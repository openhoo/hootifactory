-- Restore the blob_refs ref-count trigger that the 0000 migration squash dropped
-- (it previously lived in the hand-written 0001_first_vindicator.sql). Without it,
-- blobs.ref_count is never decremented on a freshly-migrated database: synchronous
-- reclaim, the GC sweep, and retention's refCount checks all go dead, leaking every
-- "deleted" blob in object storage. Guarded with IF EXISTS/OR REPLACE so databases
-- migrated before the squash (which still carry the trigger) upgrade cleanly.
--
-- Single authority for blobs.ref_count decrement. Fires for both application-driven
-- blob_ref deletes and FK-cascade deletes (repo/org removal), so the count can never
-- desync. Increment stays in application code on blob_ref insert; only the decrement is
-- centralized here (no AFTER INSERT trigger, so there is no double-counting).
CREATE OR REPLACE FUNCTION "blob_refs_after_delete"() RETURNS trigger AS $$
BEGIN
  UPDATE "blobs"
     SET "ref_count" = "ref_count" - 1,
         "state" = CASE WHEN "ref_count" - 1 <= 0 THEN 'pending_delete'::"public"."blob_state" ELSE "state" END,
         "pending_since" = CASE WHEN "ref_count" - 1 <= 0 THEN now() ELSE "pending_since" END
   WHERE "digest" = OLD."digest";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "blob_refs_after_delete_trg" ON "blob_refs";--> statement-breakpoint
CREATE TRIGGER "blob_refs_after_delete_trg"
  AFTER DELETE ON "blob_refs"
  FOR EACH ROW
  EXECUTE FUNCTION "blob_refs_after_delete"();
