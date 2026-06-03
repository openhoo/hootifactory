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
ALTER TABLE "registry_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scan_outbox" ADD CONSTRAINT "scan_outbox_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_outbox_artifact_uq" ON "scan_outbox" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "scan_outbox_ready_idx" ON "scan_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
INSERT INTO "scan_outbox" ("artifact_id", "status", "attempts", "next_attempt_at")
SELECT "id", 'pending', 0, now()
FROM "artifacts"
WHERE "state" = 'pending'
ON CONFLICT ("artifact_id") DO NOTHING;
