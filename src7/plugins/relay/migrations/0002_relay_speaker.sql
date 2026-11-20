ALTER TABLE relay_items ADD COLUMN owner INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE relay_items ADD COLUMN sender TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE relay_items ADD COLUMN chat TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE relay_items ADD COLUMN chat_name TEXT NOT NULL DEFAULT '';
