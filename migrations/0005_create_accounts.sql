CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  account_password_encrypted TEXT,
  totp_secret_encrypted TEXT NOT NULL,
  gpt_totp_secret_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

-- 将现有 tokens 表中已有账号去重同步至 accounts 表
INSERT OR IGNORE INTO accounts (
  account_id,
  account_password_encrypted,
  totp_secret_encrypted,
  gpt_totp_secret_encrypted,
  status,
  created_at,
  updated_at
)
SELECT 
  account_id,
  account_password_encrypted,
  totp_secret_encrypted,
  gpt_totp_secret_encrypted,
  'active',
  MIN(created_at),
  MAX(updated_at)
FROM tokens
WHERE account_id IS NOT NULL AND account_id != ''
GROUP BY account_id;
