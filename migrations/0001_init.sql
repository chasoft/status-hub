-- Status Hub schema v1. All timestamps are epoch milliseconds (UTC).
-- The UI displays them with tz_offset_minutes (default UTC).

CREATE TABLE members (
  id          TEXT PRIMARY KEY,                -- 'lily', 'harry', ...
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','pm','po','lead','dev','qa','design','content','seo','sales','social','data')),
  is_admin    INTEGER NOT NULL DEFAULT 0,      -- full authority, same as role admin
  token_hash  TEXT,                            -- hex SHA-256 of the bot's bearer token; NULL = no access
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE projects (
  code        TEXT PRIMARY KEY CHECK (length(code) BETWEEN 2 AND 5 AND code = upper(code) AND code NOT GLOB '*[^A-Z]*'),
  name        TEXT NOT NULL,
  owner_id    TEXT REFERENCES members(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  repo_url    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE modules (
  code         TEXT PRIMARY KEY,               -- 'PRJ-MOD'
  project_code TEXT NOT NULL REFERENCES projects(code),
  name         TEXT NOT NULL,
  owner_id     TEXT REFERENCES members(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_modules_project ON modules(project_code);

CREATE TABLE features (
  code         TEXT PRIMARY KEY,               -- 'PRJ-MOD-012'
  module_code  TEXT NOT NULL REFERENCES modules(code),
  project_code TEXT NOT NULL REFERENCES projects(code),
  title        TEXT NOT NULL,
  spec_url     TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  owner_id     TEXT REFERENCES members(id),
  priority     TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
  due_at       INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_features_module ON features(module_code);

CREATE TABLE tasks (
  code           TEXT PRIMARY KEY,             -- 'PRJ-MOD-012.3'
  feature_code   TEXT NOT NULL REFERENCES features(code),
  project_code   TEXT NOT NULL REFERENCES projects(code),
  title          TEXT NOT NULL,
  assignee_id    TEXT REFERENCES members(id),
  status         TEXT NOT NULL CHECK (status IN ('backlog','assigned','in_progress','review','blocked','done','cancelled')),
  created_by     TEXT REFERENCES members(id),
  created_at     INTEGER NOT NULL,
  assigned_at    INTEGER,
  started_at     INTEGER,
  last_update_at INTEGER NOT NULL,
  done_at        INTEGER,
  due_at         INTEGER,
  pr_url         TEXT
);
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_status_assigned ON tasks(status, assigned_at);
CREATE INDEX idx_tasks_project_status ON tasks(project_code, status);
CREATE INDEX idx_tasks_feature ON tasks(feature_code);

CREATE TABLE updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code   TEXT NOT NULL REFERENCES tasks(code),
  member_id   TEXT NOT NULL REFERENCES members(id),
  at          INTEGER NOT NULL,
  status_from TEXT,
  status_to   TEXT,
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  links       TEXT                                -- JSON array of URLs
);
CREATE INDEX idx_updates_task_at ON updates(task_code, at);
CREATE INDEX idx_updates_member_at ON updates(member_id, at);

CREATE TABLE blockers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code   TEXT NOT NULL REFERENCES tasks(code),
  raised_by   TEXT NOT NULL REFERENCES members(id),
  kind        TEXT NOT NULL CHECK (kind IN ('need_approval','need_info','dependency','access','bug')),
  waiting_on  TEXT NOT NULL,                      -- member id, or a configured owner/approver id
  detail      TEXT NOT NULL CHECK (length(detail) <= 500),
  opened_at   INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES members(id),
  resolution  TEXT
);
CREATE INDEX idx_blockers_resolved ON blockers(resolved_at);
CREATE INDEX idx_blockers_task ON blockers(task_code);

CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  rule       TEXT NOT NULL CHECK (rule IN ('NOT_STARTED','STALE','BLOCKED_LONG','OVERDUE')),
  fired_at   INTEGER NOT NULL,
  cleared_at INTEGER
);
-- Idempotent cron: at most one OPEN alert per (task, rule).
CREATE UNIQUE INDEX uq_alerts_open ON alerts(task_code, rule) WHERE cleared_at IS NULL;
CREATE INDEX idx_alerts_cleared ON alerts(cleared_at);

-- Race-free code allocation: scope = 'F:PRJ-MOD' (features) or 'T:PRJ-MOD-012' (tasks).
CREATE TABLE counters (
  scope TEXT PRIMARY KEY,
  next  INTEGER NOT NULL DEFAULT 0              -- last issued number
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('not_started_minutes', '15'),
  ('stale_hours', '4'),
  ('stale_work_start_hour', '8'),   -- STALE only counts working hours 08:00-22:00 local
  ('stale_work_end_hour', '22'),
  ('blocked_hours', '2'),
  ('tz_offset_minutes', '0');       -- UTC. Override with TZ_OFFSET_MINUTES or an UPDATE.
