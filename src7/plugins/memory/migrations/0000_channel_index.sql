CREATE TABLE IF NOT EXISTS memory_channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL,
  chat_type TEXT NOT NULL, direction TEXT NOT NULL, sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL, bot TEXT NOT NULL, text TEXT NOT NULL,
  at INTEGER NOT NULL,
  mentioned_bots TEXT NOT NULL DEFAULT '[]',
  rust_state INTEGER NOT NULL DEFAULT 0,
  memory_key TEXT NOT NULL DEFAULT '',
  front_only INTEGER NOT NULL DEFAULT 0
);
