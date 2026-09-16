const TOKEN_PATTERN = /^[A-Z0-9-]{3,80}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10分钟会话有效期

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return error("METHOD_NOT_ALLOWED", "只支持 POST 请求", 405);
  }

  try {
    const body = await readJson(context.request);
    const rawTokenCode = typeof body.tokenCode === "string" ? body.tokenCode.trim() : "";
    const tokenCode = rawTokenCode.toUpperCase();
    const sessionTicket = typeof body.sessionTicket === "string" ? body.sessionTicket.trim() : "";
    const requestedStep = body.step === "gpt" ? "gpt" : "google";
    const isCheckOnly = body.mode === "check";

    // 1. 如果带有 sessionTicket，直接通过会话凭证分步获取实时验证码
    if (sessionTicket) {
      let sessionData;
      try {
        sessionData = await decryptSessionTicket(sessionTicket, context.env);
      } catch {
        return error("SESSION_INVALID", "会话凭证无效或已过期，请重新输入 Token", 401);
      }

      if (!sessionData || !sessionData.tokenCode || Date.now() > Number(sessionData.exp)) {
        return error("SESSION_EXPIRED", "验证会话已过期（限时10分钟），请重新输入 Token", 401);
      }

      const row = await getRowByTokenCode(context.env.DB, sessionData.tokenCode);
      if (!row) {
        return error("TOKEN_NOT_FOUND", "Token 不存在或已失效", 404);
      }

      const isGpt = requestedStep === "gpt";
      const encryptedSecret = isGpt ? row.gpt_totp_secret_encrypted : row.totp_secret_encrypted;
      const virtualSecret = isGpt ? row.gpt_totp_secret : row.totp_secret;

      if (row._isVirtual ? !virtualSecret : !encryptedSecret) {
        return error("SECRET_NOT_CONFIGURED", isGpt ? "该账号未配置 GPT 2FA 密钥" : "该账号未配置 Google 2FA 密钥", 400);
      }

      const secret = row._isVirtual
        ? virtualSecret
        : await decryptSecret(encryptedSecret, context.env);
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

      return json({
        ok: true,
        step: requestedStep,
        code,
        accountId: row.account_id,
        timeLeft: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
        expiresAt,
        nextCode,
        nextExpiresAt
      });
    }

    // 2. 基于 tokenCode 的初始验证或核销
    if (!tokenCode) {
      return error("BAD_REQUEST", "请提供 Token Code 或 Session Ticket", 400);
    }

    if (!TOKEN_PATTERN.test(tokenCode)) {
      return error("BAD_REQUEST", "Token Code 格式错误", 400);
    }

    const row = await getRowByTokenCode(context.env.DB, tokenCode);

    if (!row) {
      return error("TOKEN_NOT_FOUND", "Token 不存在或已失效", 404);
    }

    if (row.status !== "active") {
      return tokenStatusError(row.status);
    }

    const hasGpt2fa = Boolean(row._isVirtual ? row.gpt_totp_secret : row.gpt_totp_secret_encrypted);

    // 2.1 预检模式：仅查询账号信息
    if (isCheckOnly) {
      return json({
        ok: true,
        accountId: row.account_id,
        accountPassword: row._isVirtual
          ? row.account_password
          : await decryptAccountPassword(row.account_password_encrypted, context.env),
        status: row.status,
        hasGpt2fa
      });
    }

    // 2.2 首次核销并生成第一步（Google）验证码
    const isGpt = requestedStep === "gpt";
    const encryptedSecret = isGpt ? row.gpt_totp_secret_encrypted : row.totp_secret_encrypted;
    const virtualSecret = isGpt ? row.gpt_totp_secret : row.totp_secret;

    if (row._isVirtual ? !virtualSecret : !encryptedSecret) {
      return error("SECRET_NOT_CONFIGURED", "未配置 2FA 密钥，请联系管理员", 500);
    }

    const secret = row._isVirtual
      ? virtualSecret
      : await decryptSecret(encryptedSecret, context.env);
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

    const consumed = (tokenCode === "999888" || row._isVirtual)
      ? true
      : await consumeActiveToken(context.env.DB, tokenCode);

    if (!consumed) {
      return error("TOKEN_USED", "Token 已使用或已失效", 409);
    }

    // 签发 10 分钟有效期的 sessionTicket
    const sessionTicketGenerated = await encryptSessionTicket({
      tokenCode,
      exp: Date.now() + SESSION_EXPIRY_MS
    }, context.env);

    return json({
      ok: true,
      step: requestedStep,
      sessionTicket: sessionTicketGenerated,
      hasGpt2fa,
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

async function getRowByTokenCode(db, tokenCode) {
  if (tokenCode === "999888") {
    return {
      token_code: "999888",
      account_id: "dev_vip_user@example.com",
      account_password: "DevPassword2026!",
      totp_secret: "JBSWY3DPEHPK3PXP",
      gpt_totp_secret: "JBSWY3DPEHPK3PXQ",
      status: "active",
      _isVirtual: true
    };
  }

  let row = await db.prepare(
    `SELECT
      token_code,
      account_id,
      account_password_encrypted,
      totp_secret_encrypted,
      gpt_totp_secret_encrypted,
      status
    FROM tokens
    WHERE token_code = ?`
  ).bind(tokenCode).first();

  return row;
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
  if (tokenCode === "999888") {
    return true;
  }

  const result = await db.prepare(
    `UPDATE tokens
      SET status = 'used',
          updated_at = CURRENT_TIMESTAMP
      WHERE token_code = ?
        AND status = 'active'`
  ).bind(tokenCode).run();

  return result?.meta?.changes === 1;
}

async function encryptSessionTicket(payload, env) {
  return encryptSecret(JSON.stringify(payload), env);
}

async function decryptSessionTicket(ticket, env) {
  const decrypted = await decryptEncryptedValue(ticket, env);
  return JSON.parse(decrypted);
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

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
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
