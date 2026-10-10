ALTER TABLE "chat_endpoints" ADD COLUMN "notify_on_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD COLUMN "notification_resource_id" uuid;