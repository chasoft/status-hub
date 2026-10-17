-- STS-CORE-002: time-in-status. Every status a task enters is a period
-- [started_at, ended_at). ended_at IS NULL = the task's current status.
-- Epoch ms UTC. The UI applies tz_offset_minutes from settings (default UTC).

CREATE TABLE status_periods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code  TEXT NOT NULL REFERENCES tasks(code),
  status     TEXT NOT NULL CHECK (status IN ('backlog','assigned','in_progress','review','blocked','done','cancelled')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  member_id  TEXT REFERENCES members(id)          -- who moved the task into this status (NULL = backfill w/o author)
);
CREATE INDEX idx_periods_task_started ON status_periods(task_code, started_at);
-- At most one open period per task.
CREATE UNIQUE INDEX uq_periods_open ON status_periods(task_code) WHERE ended_at IS NULL;

-- Backfill: one open period per existing task for its current status, starting at the
-- last update that moved it into that status, else last_update_at, else created_at.
INSERT INTO status_periods (task_code, status, started_at, member_id)
SELECT t.code, t.status,
  COALESCE(
    (SELECT MAX(u.at) FROM updates u WHERE u.task_code = t.code AND u.status_to = t.status
       AND (u.status_from IS NULL OR u.status_from != u.status_to)),
    t.last_update_at, t.created_at),
  COALESCE(
    (SELECT u.member_id FROM updates u WHERE u.task_code = t.code AND u.status_to = t.status
       AND (u.status_from IS NULL OR u.status_from != u.status_to) ORDER BY u.at DESC, u.id DESC LIMIT 1),
    t.created_by)
FROM tasks t;
