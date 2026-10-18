-- Leadership feedback opens one alert per task. SQLite cannot ALTER a CHECK,
-- so alerts is rebuilt to allow rule LEADERSHIP_FEEDBACK. This is not a cron
-- rule. The partial unique index stays: one open alert per task and rule.
-- Rows, the primary key sequence, indexes, and the task foreign key are kept.

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS alerts_new;
CREATE TABLE alerts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  rule       TEXT NOT NULL CHECK (rule IN ('NOT_STARTED','STALE','BLOCKED_LONG','OVERDUE','LEADERSHIP_FEEDBACK')),
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
