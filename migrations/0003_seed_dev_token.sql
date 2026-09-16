-- Seed universal dev token 999888
INSERT OR REPLACE INTO tokens (
  token_code,
  account_id,
  account_password_encrypted,
  totp_secret_encrypted,
  status,
  created_at,
  updated_at
) VALUES (
  '999888',
  'dev_vip_user@example.com',
  'kvvj1H0Od4lt9Bml.c0E1uD68nPmKbvK3Zr6xZ+E00qZffj0kuTYGCYYDlb4=',
  'Eloo5ecrfDkFv37K.vda6hXdqv78diPm36vmhn7Hip7AyTiuDpStnX2NgEk8=',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
