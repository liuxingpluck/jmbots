ALTER TABLE memory_channel_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE memory_channel_messages ADD COLUMN recalled_at INTEGER;
--> statement-breakpoint
ALTER TABLE memory_channel_messages ADD COLUMN platform_keys TEXT NOT NULL DEFAULT '[]';
