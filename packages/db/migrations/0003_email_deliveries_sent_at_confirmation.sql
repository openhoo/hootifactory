ALTER TABLE "email_deliveries" ALTER COLUMN "sent_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "email_deliveries" ALTER COLUMN "sent_at" DROP NOT NULL;