import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const devVarsPath = path.resolve(".dev.vars");
let encryptionKey = "AHZeXD7LP+vnpIVEeqHuDZWWmW5jQmJa4OfQILec0JA=";

if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, "utf8");
  for (const line of content.split("\n")) {
    const [k, v] = line.split("=");
    if (k?.trim() === "TOTP_ENCRYPTION_KEY" && v?.trim()) {
      encryptionKey = v.trim();
    }
  }
}

const dbDir = path.resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const sqliteFiles = fs.existsSync(dbDir)
  ? fs.readdirSync(dbDir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
  : [];

if (sqliteFiles.length === 0) {
  console.error("未找到本地 D1 数据库文件，请先运行本地开发服务。");
  process.exit(1);
}

const dbPath = path.join(dbDir, sqliteFiles[0]);
const db = new DatabaseSync(dbPath);

// 确保表结构存在
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token_code TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    account_password_encrypted TEXT,
    totp_secret_encrypted TEXT NOT NULL,
    gpt_totp_secret_encrypted TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// 检查是否缺少 gpt_totp_secret_encrypted 列
const tableInfo = db.prepare("PRAGMA table_info(tokens)").all();
const hasGptCol = tableInfo.some((col) => col.name === "gpt_totp_secret_encrypted");
if (!hasGptCol) {
  try {
    db.exec("ALTER TABLE tokens ADD COLUMN gpt_totp_secret_encrypted TEXT;");
  } catch {}
}

const hasPassCol = tableInfo.some((col) => col.name === "account_password_encrypted");
if (!hasPassCol) {
  try {
    db.exec("ALTER TABLE tokens ADD COLUMN account_password_encrypted TEXT;");
  } catch {}
}

async function encrypt(plaintext) {
  if (!plaintext) return null;
  const keyBytes = Buffer.from(encryptionKey, "base64");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
}

function generateRandomToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const parts = [];
  for (let i = 0; i < 4; i++) {
    let part = "";
    for (let j = 0; j < 4; j++) {
      part += chars[bytes[i * 4 + j] % chars.length];
    }
    parts.push(part);
  }
  return `TK-${parts.join("-")}`;
}

async function main() {
  const tokenCode = generateRandomToken();
  const accountId = "test_user_vip@gmail.com";
  const password = "ChatGPT_Pass2026!";
  // Google 2FA 密钥 (RFC 4226/6238 示例密钥)
  const googleTotpSecret = "JBSWY3DPEHPK3PXP"; 
  // GPT 2FA 密钥 (不同的示例密钥)
  const gptTotpSecret = "JBSWY3DPEHPK3PXQ"; 

  const encryptedPassword = await encrypt(password);
  const encryptedGoogleSecret = await encrypt(googleTotpSecret);
  const encryptedGptSecret = await encrypt(gptTotpSecret);

  const stmt = db.prepare(`
    INSERT INTO tokens (
      token_code,
      account_id,
      account_password_encrypted,
      totp_secret_encrypted,
      gpt_totp_secret_encrypted,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  stmt.run(tokenCode, accountId, encryptedPassword, encryptedGoogleSecret, encryptedGptSecret);

  console.log(JSON.stringify({
    success: true,
    tokenCode,
    accountId,
    password,
    googleTotpSecret,
    gptTotpSecret,
    status: "active"
  }, null, 2));
}

main().catch(console.error);
