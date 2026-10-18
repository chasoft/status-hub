-- Versioned markdown request on a task. Each edit inserts a row.
-- Older versions stay. Application code never updates body.

CREATE TABLE request_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  version    INTEGER NOT NULL CHECK (version >= 1),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  author_id  TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  note       TEXT CHECK (note IS NULL OR length(note) <= 500),
  UNIQUE (task_code, version)
);
CREATE INDEX idx_request_versions_task ON request_versions(task_code, version DESC);
