-- Outbound webhooks per member, an outbox for retries, and alert rule WEBHOOK_FAILED.
-- webhook_secret is write-only: no API or page returns it. It is AES-GCM encrypted
-- when the Worker has WEBHOOK_SECRET_KEY. Forward-only. Do not rename 0001 through 0012.

ALTER TABLE members ADD COLUMN webhook_url TEXT;
ALTER TABLE members ADD COLUMN webhook_header_name TEXT;
ALTER TABLE members ADD COLUMN webhook_secret TEXT;

CREATE TABLE webhook_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       TEXT NOT NULL REFERENCES members(id),
  task_code       TEXT REFERENCES tasks(code),
  event           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_status     INTEGER,
  last_error      TEXT,
  delivered_at    INTEGER,
  failed_at       INTEGER
);
CREATE INDEX idx_webhook_outbox_due ON webhook_outbox(next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX idx_webhook_outbox_task ON webhook_outbox(task_code);

-- SQLite cannot ALTER a CHECK, so alerts is rebuilt the same way as 0011.
PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS alerts_new;
CREATE TABLE alerts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  rule       TEXT NOT NULL CHECK (rule IN ('NOT_STARTED','STALE','BLOCKED_LONG','OVERDUE','LEADERSHIP_FEEDBACK','WEBHOOK_FAILED')),
  fired_at   INTEGER NOT NULL,
  cleared_at INTEGER
);
INSERT INTO alerts_new (id, task_code, rule, fired_at, cleared_at)
SELECT id, task_code, rule, fired_at, cleared_at FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
CREATE UNIQUE INDEX uq_alerts_open ON alerts(task_code, rule) WHERE cleared_at IS NULL;
CREATE INDEX idx_alerts_cleared ON alerts(cleared_at);

UPDATE sqlite_sequence SET name = 'alerts'
WHERE name = 'alerts_new'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'alerts');
UPDATE sqlite_sequence
SET seq = (SELECT IFNULL(MAX(id), 0) FROM alerts)
WHERE name = 'alerts'
  AND seq < (SELECT IFNULL(MAX(id), 0) FROM alerts);
DELETE FROM sqlite_sequence WHERE name = 'alerts_new';
