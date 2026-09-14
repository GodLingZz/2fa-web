const TOKEN_PATTERN = /^[A-Z0-9-]{3,80}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return error("METHOD_NOT_ALLOWED", "只支持 POST 请求", 405);
  }

  try {
    const body = await readJson(context.request);
    const rawTokenCode = typeof body.tokenCode === "string" ? body.tokenCode.trim() : "";
    const tokenCode = rawTokenCode.toUpperCase();
    const isCheckOnly = body.mode === "check";

    if (!tokenCode) {
      return error("BAD_REQUEST", "请提供 Token Code", 400);
    }

    if (!TOKEN_PATTERN.test(tokenCode)) {
      return error("BAD_REQUEST", "Token Code 格式错误", 400);
    }

    const row = await context.env.DB.prepare(
      `SELECT
        token_code,
        account_id,
        account_password_encrypted,
        totp_secret_encrypted,
        status
      FROM tokens
      WHERE token_code = ?`
    ).bind(tokenCode).first();

    if (!row) {
      return error("TOKEN_NOT_FOUND", "Token 不存在或已失效", 404);
    }

    if (row.status !== "active") {
      return tokenStatusError(row.status);
    }

    if (isCheckOnly) {
      return json({
        ok: true,
        accountId: row.account_id,
        accountPassword: await decryptAccountPassword(row.account_password_encrypted, context.env),
        status: row.status
      });
    }

    const secret = await decryptSecret(row.totp_secret_encrypted, context.env);
    const secretBytes = base32ToBytes(secret);

    if (secretBytes.length === 0) {
      return error("SECRET_INVALID", "Token 密钥无效，请联系管理员", 500);
    }

    const now = Date.now();
    const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
    const code = await generateTotp(secretBytes, counter);
    const expiresAt = (counter + 1) * TOTP_PERIOD_SECONDS * 1000;
    const nextCode = await generateTotp(secretBytes, counter + 1);
    const nextExpiresAt = (counter + 2) * TOTP_PERIOD_SECONDS * 1000;
    const consumed = await consumeActiveToken(context.env.DB, tokenCode);

    if (!consumed) {
      return error("TOKEN_USED", "Token 已使用或已失效", 409);
    }

    return json({
      ok: true,
      code,
      accountId: row.account_id,
      timeLeft: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
      expiresAt,
      nextCode,
      nextExpiresAt
    });
  } catch (err) {
    if (err instanceof SecretFormatError) {
      return error("SECRET_INVALID", "Token 密钥无效，请联系管理员", 500);
    }

    return error("SERVER_ERROR", "校验失败，请稍后重试", 500);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
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

function tokenStatusError(status) {
  if (status === "used") {
    return error("TOKEN_USED", "Token 已使用", 409);
  }

  return error("TOKEN_DISABLED", "Token 已停用", 403);
}

async function consumeActiveToken(db, tokenCode) {
  const result = await db.prepare(
    `UPDATE tokens
      SET status = 'used',
          updated_at = CURRENT_TIMESTAMP
      WHERE token_code = ?
        AND status = 'active'`
  ).bind(tokenCode).run();

  return result?.meta?.changes === 1;
}

async function decryptSecret(encryptedSecret, env) {
  const plaintext = await decryptEncryptedValue(encryptedSecret, env);
  return plaintext.replace(/\s+/g, "").toUpperCase();
}

async function decryptAccountPassword(encryptedPassword, env) {
  if (!encryptedPassword) {
    return "";
  }

  return decryptEncryptedValue(encryptedPassword, env);
}

async function decryptEncryptedValue(encryptedValue, env) {
  const [ivValue, ciphertextValue] = String(encryptedValue || "").split(".");
  const iv = base64ToBytes(ivValue || "");
  const ciphertext = base64ToBytes(ciphertextValue || "");
  const keyBytes = base64ToBytes(env.TOTP_ENCRYPTION_KEY || "");

  if (iv.length !== 12 || ciphertext.length === 0 || keyBytes.length !== 32) {
    throw new SecretFormatError();
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

  return new TextDecoder().decode(plaintext);
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

function base32ToBytes(value) {
  const normalized = value.replace(/=+$/, "");
  let bits = 0;
  let valueBuffer = 0;
  const bytes = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);

    if (index === -1) {
      return new Uint8Array();
    }

    valueBuffer = (valueBuffer << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((valueBuffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

async function generateTotp(secretBytes, counter) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const counterBytes = counterToBytes(counter);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function counterToBytes(counter) {
  const bytes = new Uint8Array(8);
  let value = counter;

  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }

  return bytes;
}

class SecretFormatError extends Error {}
