DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_tokens'
      AND column_name = 'scopes'
  ) THEN
    ALTER TABLE "api_tokens" RENAME COLUMN "scopes" TO "grants";
  END IF;
END $$;--> statement-breakpoint
UPDATE "api_tokens"
SET "grants" = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN val ? 'resource' THEN val
        ELSE jsonb_build_object(
          'resource', 'repository',
          'repository', val ->> 'repository',
          'actions', COALESCE(val -> 'actions', '[]'::jsonb)
        )
      END
    )
    FROM jsonb_array_elements("api_tokens"."grants") AS item(val)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof("grants") = 'array';--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "revoked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "revoked_by_token_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rotated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rotated_by_token_id" uuid;
