-- AUTH_MODE=token. Raw login tokens are never stored.
-- token_hash is the hex SHA-256 of the token from scripts/gen-ui-login.mjs.
-- ui_sessions backs the signed session cookie so logout can revoke it.

CREATE TABLE ui_login_tokens (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);

CREATE TABLE ui_sessions (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX idx_ui_sessions_email ON ui_sessions(email);
