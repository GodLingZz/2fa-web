const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_FORMAT = /^TK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
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

    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) {
      return error("BAD_REQUEST", "请指定账号 ID", 400);
    }

    const count = Number(body.count || 1);
    if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
      return error("BAD_REQUEST", `生成数量必须是 ${MIN_COUNT}-${MAX_COUNT} 的整数`, 400);
    }

    const status = typeof body.status === "string" && body.status.trim()
      ? body.status.trim().toLowerCase()
      : "active";

    if (!VALID_STATUSES.has(status)) {
      return error("BAD_REQUEST", "状态只能是 active 或 disabled", 400);
    }

    // 从 accounts 表拉取已存的凭据
    const account = await context.env.DB.prepare(
      `SELECT
        account_id,
        account_password_encrypted,
        totp_secret_encrypted,
        gpt_totp_secret_encrypted,
        status as account_status
      FROM accounts
      WHERE account_id = ?`
    ).bind(accountId).first();

    if (!account) {
      return error("NOT_FOUND", `未找到账号「${accountId}」，请先创建该账号。`, 404);
    }

    const generatedTokens = [];
    const seenTokens = new Set();

    for (let i = 0; i < count; i += 1) {
      generatedTokens.push(await generateUniqueToken(context.env.DB, seenTokens));
    }

    const statements = generatedTokens.map((tokenCode) => {
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
        account.account_id,
        account.account_password_encrypted,
        account.totp_secret_encrypted,
        account.gpt_totp_secret_encrypted,
        status
      );
    });

    await context.env.DB.batch(statements);

    return json({
      ok: true,
      accountId: account.account_id,
      generated: generatedTokens.length,
      tokens: generatedTokens.map((tokenCode) => ({
        tokenCode,
        accountId: account.account_id,
        status,
        hasGpt2fa: Boolean(account.gpt_totp_secret_encrypted)
      }))
    });
  } catch (err) {
    return error("SERVER_ERROR", "批量发码失败，请稍后重试: " + err.message, 500);
  }
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
