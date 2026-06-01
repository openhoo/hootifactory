CREATE TYPE "public"."auth_email_token_purpose" AS ENUM('password_reset', 'oidc_link');--> statement-breakpoint
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
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_email_tokens_user_purpose_idx" ON "auth_email_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_expires_idx" ON "auth_email_tokens" USING btree ("expires_at");