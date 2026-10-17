-- Drop fixed requester, approver, and leadership-author checks.
-- Those values now come from OWNER_IDS, APPROVER_IDS, and LEADERSHIP_AUTHORS.
-- Additive rebuild: works for a database created from these files and for an
-- older database whose earlier migrations still have a fixed allow-list.
-- D1 applies this file once (d1_migrations). Do not rename 0001..0006.

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
  requested_by   TEXT,
  requested_at   INTEGER,
  request_link   TEXT CHECK (request_link IS NULL OR (
    length(request_link) <= 500 AND (
      substr(request_link, 1, 8) = 'https://' OR substr(request_link, 1, 7) = 'http://'))),
  reviewer_id    TEXT REFERENCES members(id)
);
INSERT INTO tasks_new (
  code, feature_code, project_code, title, assignee_id, status, created_by, created_at,
  assigned_at, started_at, last_update_at, done_at, due_at, pr_url,
  requested_by, requested_at, request_link, reviewer_id)
SELECT
  code, feature_code, project_code, title, assignee_id, status, created_by, created_at,
  assigned_at, started_at, last_update_at, done_at, due_at, pr_url,
  requested_by, requested_at, request_link, reviewer_id
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_status_assigned ON tasks(status, assigned_at);
CREATE INDEX idx_tasks_project_status ON tasks(project_code, status);
CREATE INDEX idx_tasks_feature ON tasks(feature_code);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status);

DROP TABLE IF EXISTS updates_new;
CREATE TABLE updates_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code   TEXT NOT NULL REFERENCES tasks(code),
  member_id   TEXT NOT NULL REFERENCES members(id),
  at          INTEGER NOT NULL,
  status_from TEXT,
  status_to   TEXT,
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  links       TEXT,
  approved_by TEXT
);
INSERT INTO updates_new (id, task_code, member_id, at, status_from, status_to, note, links, approved_by)
SELECT id, task_code, member_id, at, status_from, status_to, note, links, approved_by FROM updates;
DROP TABLE updates;
ALTER TABLE updates_new RENAME TO updates;
CREATE INDEX idx_updates_task_at ON updates(task_code, at);
CREATE INDEX idx_updates_member_at ON updates(member_id, at);

UPDATE sqlite_sequence SET name = 'updates'
WHERE name = 'updates_new'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'updates');
UPDATE sqlite_sequence
SET seq = (SELECT IFNULL(MAX(id), 0) FROM updates)
WHERE name = 'updates'
  AND seq < (SELECT IFNULL(MAX(id), 0) FROM updates);
DELETE FROM sqlite_sequence WHERE name = 'updates_new';

DROP TABLE IF EXISTS feedback_new;
CREATE TABLE feedback_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code TEXT NOT NULL REFERENCES tasks(code),
  author    TEXT NOT NULL,
  note      TEXT NOT NULL CHECK (length(note) <= 500),
  at        INTEGER NOT NULL,
  read_at   INTEGER,
  read_by   TEXT
);
INSERT INTO feedback_new (id, task_code, author, note, at, read_at, read_by)
SELECT id, task_code, author, note, at, read_at, read_by FROM feedback;
DROP TABLE feedback;
ALTER TABLE feedback_new RENAME TO feedback;
CREATE INDEX idx_feedback_task ON feedback(task_code, read_by);

UPDATE sqlite_sequence SET name = 'feedback'
WHERE name = 'feedback_new'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'feedback');
UPDATE sqlite_sequence
SET seq = (SELECT IFNULL(MAX(id), 0) FROM feedback)
WHERE name = 'feedback'
  AND seq < (SELECT IFNULL(MAX(id), 0) FROM feedback);
DELETE FROM sqlite_sequence WHERE name = 'feedback_new';
