-- Leadership feedback on a task.
-- Separate from `updates` because the author is the UI session display name, not a member id.
-- read_at and read_by stay NULL until the current assignee reads the note via get_task.
-- A later assignee (read_by != assignee) sees it as unread again.

CREATE TABLE feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code TEXT NOT NULL REFERENCES tasks(code),
  author    TEXT NOT NULL,
  note      TEXT NOT NULL CHECK (length(note) <= 500),
  at        INTEGER NOT NULL,                 -- epoch ms UTC
  read_at   INTEGER,                          -- NULL = not read by read_by
  read_by   TEXT                              -- member id of the assignee who last read it
);
CREATE INDEX idx_feedback_task ON feedback(task_code, read_by);
