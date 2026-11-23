CREATE TABLE feishu_seen_v2 (
  message_id TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT '',
  kind TEXT,
  at INTEGER,
  PRIMARY KEY (message_id, app_id)
);
--> statement-breakpoint
INSERT INTO feishu_seen_v2 (message_id, app_id, kind, at)
SELECT message_id, COALESCE(app_id, ''), kind, at
FROM feishu_seen
WHERE message_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE feishu_seen;
--> statement-breakpoint
ALTER TABLE feishu_seen_v2 RENAME TO feishu_seen;
