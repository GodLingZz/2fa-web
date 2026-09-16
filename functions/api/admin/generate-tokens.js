const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_FORMAT = /^TK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;
const VALID_STATUSES = new Set(["active", "disabled"]);
const MIN_COUNT = 1;
const MAX_COUNT = 100;

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return error("METHOD_NOT_ALLOWED", "只支持 POST 请求", 405);
  }

  try {
    const body = await readJson(context.request);
    const adminError = await verifyAdminPassword(body.adminPassword, context.env);

    if (adminError) {
      return adminError;
    }

    const validation = validateInput(body);

    if (!validation.ok) {
      return error("VALIDATION_FAILED", "手动生成校验失败", 400, {
        details: validation.details
      });
    }

    const encryptedSecret = await encryptSecret(validation.totpSecret, context.env);
    const encryptedGptSecret = validation.gptTotpSecret
      ? await encryptSecret(validation.gptTotpSecret, context.env)
      : null;
    const encryptedAccountPassword = await encryptSecret(validation.accountPassword, context.env);
    const generatedTokens = [];
    const seenTokens = new Set();

    for (let i = 0; i < validation.count; i += 1) {
      generatedTokens.push(await generateUniqueToken(context.env.DB, seenTokens));
    }

    const statements = [
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO accounts (
          account_id,
          account_password_encrypted,
          totp_secret_encrypted,
          gpt_totp_secret_encrypted,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).bind(
        validation.accountId,
        encryptedAccountPassword,
        encryptedSecret,
        encryptedGptSecret,
        validation.status
      ),
      ...generatedTokens.map((tokenCode) => {
        return context.env.DB.prepare(
          `INSERT INTO tokens (
            token_code,
            account_id,
            account_password_encrypted,
            totp_secret_encrypted,
            gpt_totp_secret_encrypted,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).bind(
          tokenCode,
          validation.accountId,
          encryptedAccountPassword,
          encryptedSecret,
          encryptedGptSecret,
          validation.status
        );
      })
    ];

    await context.env.DB.batch(statements);

    return json({
      ok: true,
      generated: generatedTokens.length,
      tokens: generatedTokens.map((tokenCode) => ({
        tokenCode,
        accountId: validation.accountId,
        status: validation.status,
        hasGpt2fa: Boolean(validation.gptTotpSecret)
      }))
    });
  } catch {
    return error("SERVER_ERROR", "生成 token 失败，请稍后重试", 500);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function validateInput(body) {
  const details = [];
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const accountPassword = typeof body.accountPassword === "string" ? body.accountPassword.trim() : "";
  const rawSecret = typeof body.totpSecret === "string" ? body.totpSecret.trim() : "";
  const totpSecret = rawSecret.replace(/\s+/g, "").toUpperCase();
  const rawGptSecret = typeof body.gptTotpSecret === "string" ? body.gptTotpSecret.trim() : "";
  const gptTotpSecret = rawGptSecret.replace(/\s+/g, "").toUpperCase();
  const status = typeof body.status === "string" && body.status.trim()
    ? body.status.trim().toLowerCase()
    : "active";
  const count = Number(body.count);

  if (!accountId) {
    details.push({ field: "account_id", message: "请填写账号 ID" });
  }

  if (!accountPassword) {
    details.push({ field: "account_password", message: "请填写账号密码" });
  }

  if (!rawSecret) {
    details.push({ field: "totp_secret", message: "请填写 Google 2FA Base32 密钥" });
  } else if (!isValidBase32(totpSecret)) {
    details.push({ field: "totp_secret", message: "Google 2FA Base32 密钥格式错误" });
  }

  if (gptTotpSecret && !isValidBase32(gptTotpSecret)) {
    details.push({ field: "gpt_totp_secret", message: "GPT 2FA Base32 密钥格式错误" });
  }

  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    details.push({ field: "count", message: `生成数量必须是 ${MIN_COUNT}-${MAX_COUNT} 的整数` });
  }

  if (!VALID_STATUSES.has(status)) {
    details.push({ field: "status", message: "状态只能是 active 或 disabled" });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  return { ok: true, accountId, accountPassword, totpSecret, gptTotpSecret, count, status };
}

function isValidBase32(value) {
  if (!value || !BASE32_PATTERN.test(value)) {
    return false;
  }

  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || /^=+$/.test(value.slice(firstPadding));
}

async function generateUniqueToken(db, seenTokens) {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const tokenCode = generateToken();

    if (!seenTokens.has(tokenCode) && !(await tokenExists(db, tokenCode))) {
      seenTokens.add(tokenCode);
      return tokenCode;
    }
  }

  throw new Error("Unable to generate unique token");
}

function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const chars = [...bytes].map((byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]);
  const tokenCode = `TK-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;

  if (!TOKEN_FORMAT.test(tokenCode)) {
    throw new Error("Generated token does not match token format");
  }

  return tokenCode;
}

async function tokenExists(db, tokenCode) {
  const row = await db
    .prepare("SELECT token_code FROM tokens WHERE token_code = ?")
    .bind(tokenCode)
    .first();

  return Boolean(row);
}

async function encryptSecret(secret, env) {
  const keyBytes = base64ToBytes(env.TOTP_ENCRYPTION_KEY || "");

  if (keyBytes.length !== 32) {
    throw new Error("Invalid TOTP_ENCRYPTION_KEY");
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret)
  );

  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

function base64ToBytes(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function error(errorCode, message, status = 400, extra = {}) {
  return json({ ok: false, error: errorCode, message, ...extra }, status);
}

async function verifyAdminPassword(adminPassword, env) {
  if (typeof adminPassword !== "string" || !adminPassword) {
    return error("UNAUTHORIZED", "管理员密码错误", 401);
  }

  if (!env.ADMIN_PASSWORD_HASH) {
    return error("SERVER_ERROR", "管理员密码未配置", 500);
  }

  const digest = await sha256Hex(adminPassword);
  const configuredHash = (env.ADMIN_PASSWORD_HASH || "").trim().toLowerCase();

  if (!constantTimeEqual(digest, configuredHash)) {
    return error("UNAUTHORIZED", "管理员密码错误", 401);
  }

  return null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return result === 0;
}
