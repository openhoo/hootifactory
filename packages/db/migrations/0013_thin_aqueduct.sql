CREATE TABLE "auth_throttle_buckets" (
	"bucket_hash" varchar(64) PRIMARY KEY NOT NULL,
	"scope" varchar(64) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_throttle_buckets_reset_at_idx" ON "auth_throttle_buckets" USING btree ("reset_at");