/** Test-only members and sample projects. Production migration 0002 is a no-op. */
export const FIXTURE_SQL = `
INSERT INTO members (id, name, role, is_admin, created_at) VALUES
  ('lily', 'Lily', 'admin', 1, 1),
  ('harry', 'Harry', 'lead', 1, 1),
  ('my', 'My', 'pm', 0, 1),
  ('olivia', 'Olivia', 'po', 0, 1),
  ('peter', 'Peter', 'dev', 0, 1),
  ('ethan', 'Ethan', 'dev', 0, 1),
  ('quinn', 'Quinn', 'qa', 0, 1),
  ('jennifer', 'Jennifer', 'design', 0, 1),
  ('mira', 'Mira', 'design', 0, 1),
  ('jane', 'Jane', 'content', 0, 1),
  ('leo', 'Leo', 'seo', 0, 1),
  ('anna', 'Anna', 'sales', 0, 1),
  ('chloe', 'Chloe', 'social', 0, 1),
  ('daniel', 'Daniel', 'data', 0, 1);

INSERT INTO projects (code, name, owner_id, repo_url, created_at) VALUES
  ('SCOS', 'Sample OS', 'harry', NULL, 1),
  ('SCG', 'Sample Site', 'peter', NULL, 1),
  ('SCT', 'Sample Trips', 'peter', NULL, 1),
  ('VMB', 'Sample Flights', 'peter', NULL, 1),
  ('XDL', 'Sample Build', 'peter', NULL, 1),
  ('SCV', 'Sample Stay', 'peter', NULL, 1),
  ('CNT', 'Sample Content', 'olivia', NULL, 1),
  ('STS', 'Status Hub', 'lily', NULL, 1);

INSERT INTO modules (code, project_code, name, owner_id, created_at)
  SELECT code || '-CORE', code, 'Core', owner_id, 1 FROM projects;

INSERT INTO modules (code, project_code, name, owner_id, created_at) VALUES
  ('SCOS-MAIL', 'SCOS', 'Mail', 'harry', 1),
  ('SCOS-QLY', 'SCOS', 'Operations', 'ethan', 1),
  ('SCOS-AUTH', 'SCOS', 'Auth', 'harry', 1);
`;
