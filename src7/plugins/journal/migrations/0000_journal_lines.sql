CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  listeners TEXT NOT NULL,
  text TEXT NOT NULL,
  code TEXT NOT NULL,
  site TEXT NOT NULL,
  bot TEXT,
  session_id TEXT,
  message_id INTEGER,
  source_id TEXT,
  vars TEXT NOT NULL
);
