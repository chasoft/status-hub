-- pending_approval status and request fields. Forward-only. D1 applies this file once (d1_migrations).
-- SQLite cannot ALTER a CHECK, so tasks and status_periods are rebuilt with
-- pending_approval added. Blockers.kind is intentionally NOT rebuilt: legacy
-- rows with kind 'need_approval' stay readable. New need_approval blockers are
-- rejected in application code.
--
-- defer_foreign_keys lets the tasks rebuild drop and rename inside D1's
-- migration transaction while updates/blockers/alerts/status_periods still
-- reference tasks(code).

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS tasks_new;
CREATE TABLE tasks_new (
  code           TEXT PRIMARY KEY,
  feature_code   TEXT NOT NULL REFERENCES features(code),
  project_code   TEXT NOT NULL REFERENCES projects(code),
  title          TEXT NOT NULL,
  assignee_id    TEXT REFERENCES members(id),
  status         TEXT NOT NULL CHECK (status IN (
    'pending_approval','backlog','assigned','in_progress','review','blocked','done','cancelled')),
  created_by     TEXT REFERENCES members(id),
  created_at     INTEGER NOT NULL,
  assigned_at    INTEGER,
  started_at     INTEGER,
  last_update_at INTEGER NOT NULL,
  done_at        INTEGER,
  due_at         INTEGER,
  pr_url         TEXT,
  -- Nullable so existing rows stay valid. All three must be
  -- set at create time or the task is forced to pending_approval.
  requested_by   TEXT,
  requested_at   INTEGER,
  request_link   TEXT CHECK (request_link IS NULL OR (
    length(request_link) <= 500 AND (
      substr(request_link, 1, 8) = 'https://' OR substr(request_link, 1, 7) = 'http://')))
);
INSERT INTO tasks_new (
  code, feature_code, project_code, title, assignee_id, status, created_by, created_at,
  assigned_at, started_at, last_update_at, done_at, due_at, pr_url)
SELECT
  code, feature_code, project_code, title, assignee_id, status, created_by, created_at,
  assigned_at, started_at, last_update_at, done_at, due_at, pr_url
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_status_assigned ON tasks(status, assigned_at);
CREATE INDEX idx_tasks_project_status ON tasks(project_code, status);
CREATE INDEX idx_tasks_feature ON tasks(feature_code);

DROP TABLE IF EXISTS status_periods_new;
CREATE TABLE status_periods_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  status     TEXT NOT NULL CHECK (status IN (
    'pending_approval','backlog','assigned','in_progress','review','blocked','done','cancelled')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  member_id  TEXT REFERENCES members(id)
);
INSERT INTO status_periods_new (id, task_code, status, started_at, ended_at, member_id)
SELECT id, task_code, status, started_at, ended_at, member_id FROM status_periods;
DROP TABLE status_periods;
ALTER TABLE status_periods_new RENAME TO status_periods;
CREATE INDEX idx_periods_task_started ON status_periods(task_code, started_at);
CREATE UNIQUE INDEX uq_periods_open ON status_periods(task_code) WHERE ended_at IS NULL;

-- Keep the autoincrement counter ahead of copied ids (no-op on an empty table).
UPDATE sqlite_sequence SET name = 'status_periods'
WHERE name = 'status_periods_new'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'status_periods');
UPDATE sqlite_sequence
SET seq = (SELECT IFNULL(MAX(id), 0) FROM status_periods)
WHERE name = 'status_periods'
  AND seq < (SELECT IFNULL(MAX(id), 0) FROM status_periods);
DELETE FROM sqlite_sequence WHERE name = 'status_periods_new';

-- Who actually approved or rejected a pending_approval task.
-- Application code checks this against OWNER_IDS and APPROVER_IDS.
ALTER TABLE updates ADD COLUMN approved_by TEXT;
