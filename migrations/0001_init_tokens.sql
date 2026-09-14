CREATE TABLE IF NOT EXISTS tokens (
  token_code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  totp_secret_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_account_id ON tokens(account_id);
