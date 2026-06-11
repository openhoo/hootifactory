CREATE TABLE "user_deactivation_snapshots" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"memberships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_memberships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deactivated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_deactivation_snapshots" ADD CONSTRAINT "user_deactivation_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;