-- Linked cloud agent shown on the task page. Nullable; set_agent writes these.
-- Forward-only. Do not rename 0001 through 0011.

ALTER TABLE tasks ADD COLUMN agent_url TEXT;
ALTER TABLE tasks ADD COLUMN agent_status TEXT;
ALTER TABLE tasks ADD COLUMN agent_updated_at INTEGER;
