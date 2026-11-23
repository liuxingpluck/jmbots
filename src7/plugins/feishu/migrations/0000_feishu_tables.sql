CREATE TABLE IF NOT EXISTS feishu_seen (
  message_id TEXT PRIMARY KEY,
  app_id TEXT,
  kind TEXT,
  at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feishu_p2p (
  app_id TEXT PRIMARY KEY,
  chat_id TEXT,
  open_id TEXT,
  message_id TEXT,
  at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feishu_cards (
  card_id TEXT PRIMARY KEY,
  kind TEXT,
  ref TEXT,
  ended INTEGER,
  at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feishu_cards_ref ON feishu_cards (kind, ref);
