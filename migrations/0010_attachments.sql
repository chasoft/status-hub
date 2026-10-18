-- File attachments (metadata in D1, bytes in R2) and output links.
-- A new upload of the same task + group + name inserts another version.
-- r2_key is unique and is never rewritten.
-- Output links do not use R2. Moving a task to review requires an output
-- attachment version or an output link (including links on that status change).

CREATE TABLE attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  grp        TEXT NOT NULL CHECK (grp IN ('requirement', 'output')),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  UNIQUE (task_code, grp, name)
);
CREATE INDEX idx_attachments_task ON attachments(task_code, grp);

CREATE TABLE attachment_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id),
  version       INTEGER NOT NULL CHECK (version >= 1),
  r2_key        TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  author_id     TEXT NOT NULL REFERENCES members(id),
  created_at    INTEGER NOT NULL,
  note          TEXT CHECK (note IS NULL OR length(note) <= 500),
  UNIQUE (attachment_id, version)
);
CREATE INDEX idx_attachment_versions_att ON attachment_versions(attachment_id, version DESC);

CREATE TABLE output_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  url        TEXT NOT NULL CHECK (length(url) <= 500),
  author_id  TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  note       TEXT CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX idx_output_links_task ON output_links(task_code, id);

-- One-time upload tokens for the MCP upload-URL flow. The raw token is the
-- capability. It is not a public object URL. The caller still authenticates.
CREATE TABLE attachment_uploads (
  token      TEXT PRIMARY KEY,
  task_code  TEXT NOT NULL,
  grp        TEXT NOT NULL CHECK (grp IN ('requirement', 'output')),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  note       TEXT,
  author_id  TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

ALTER TABLE updates ADD COLUMN request_version INTEGER;
ALTER TABLE updates ADD COLUMN output_ref TEXT;

ALTER TABLE feedback ADD COLUMN request_version INTEGER;
ALTER TABLE feedback ADD COLUMN output_ref TEXT;
