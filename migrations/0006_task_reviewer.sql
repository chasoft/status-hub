-- Reviewer for tasks moving to review. Nullable; report_status requires an
-- active member when the task has none yet. Forward-only. Do not rename this file.

ALTER TABLE tasks ADD COLUMN reviewer_id TEXT REFERENCES members(id);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status);
