const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_FORMAT = /^TK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;
const VALID_STATUSES = new Set(["active", "disabled"]);

export async function onRequest(context) {
  const method = context.request.method;

  if (method === "GET") {
    return handleGet(context);
  }

  if (method === "POST") {
    return handlePost(context);
  }

  if (method === "PUT") {
    return handlePut(context);
  }

  if (method === "DELETE") {
    return handleDelete(context);
  }

  return error("METHOD_NOT_ALLOWED", "不支持的请求方法", 405);
}

// 确保 accounts 表存在并容错
async function ensureAccountsTable(db) {
  try {
    await db.prepare(`
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
    `).run();

    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    `).run();
  } catch {}
}

async function handleGet(context) {
  try {
    const url = new URL(context.request.url);
    const adminError = await verifyAdminPassword(url.searchParams.get("adminPassword"), context.env);

    if (adminError) {
      return adminError;
    }

    await ensureAccountsTable(context.env.DB);

    // 查询所有账号基本信息
    const accountsResult = await context.env.DB.prepare(
      `SELECT
        account_id,
        account_password_encrypted,
        totp_secret_encrypted,
        gpt_totp_secret_encrypted,
        status,
        note,
        created_at,
        updated_at
      FROM accounts
      ORDER BY created_at DESC, account_id ASC`
    ).all();

    // 查询每个账号的 token 状态统计
    const statsResult = await context.env.DB.prepare(
      `SELECT
        account_id,
        COUNT(*) as total_tokens,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_tokens,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used_tokens,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled_tokens
      FROM tokens
      GROUP BY account_id`
    ).all();

    const statsMap = new Map();
    for (const row of statsResult.results || []) {
      statsMap.set(row.account_id, {
        totalTokens: Number(row.total_tokens || 0),
        activeTokens: Number(row.active_tokens || 0),
        usedTokens: Number(row.used_tokens || 0),
        disabledTokens: Number(row.disabled_tokens || 0)
      });
    }

    // 查询每个账号的首个可用 token（用于前端一键秒复制）
    const firstActiveTokensResult = await context.env.DB.prepare(
      `SELECT account_id, token_code
       FROM tokens
       WHERE status = 'active'
       GROUP BY account_id`
    ).all();

    const firstTokenMap = new Map();
    for (const row of firstActiveTokensResult.results || []) {
      firstTokenMap.set(row.account_id, row.token_code);
    }

    const accounts = await Promise.all((accountsResult.results || []).map(async (row) => {
      const stats = statsMap.get(row.account_id) || {
        totalTokens: 0,
        activeTokens: 0,
        usedTokens: 0,
        disabledTokens: 0
      };

      let accountPassword = "";
      try {
        accountPassword = row.account_password_encrypted
          ? await decryptEncryptedValue(row.account_password_encrypted, context.env)
          : "";
      } catch {}

      let totpSecret = "";
      try {
        totpSecret = row.totp_secret_encrypted
          ? (await decryptEncryptedValue(row.totp_secret_encrypted, context.env)).replace(/\s+/g, "").toUpperCase()
          : "";
      } catch {}

      let gptTotpSecret = "";
      try {
        gptTotpSecret = row.gpt_totp_secret_encrypted
          ? (await decryptEncryptedValue(row.gpt_totp_secret_encrypted, context.env)).replace(/\s+/g, "").toUpperCase()
          : "";
      } catch {}

      return {
        accountId: row.account_id,
        accountPassword,
        totpSecret,
        gptTotpSecret,
        status: row.status,
        note: row.note || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...stats,
        firstActiveToken: firstTokenMap.get(row.account_id) || null
      };
    }));

    return json({
      ok: true,
      accounts
    });
  } catch (err) {
    return error("SERVER_ERROR", "读取账号列表失败，请稍后重试: " + err.message, 500);
  }
}

async function handlePost(context) {
  try {
    const body = await readJson(context.request);
    const adminError = await verifyAdminPassword(body.adminPassword, context.env);

    if (adminError) {
      return adminError;
    }

    await ensureAccountsTable(context.env.DB);

    const validation = validateAccountInput(body);
    if (!validation.ok) {
      return error("VALIDATION_FAILED", "账号信息校验失败", 400, {
        details: validation.details
      });
    }

    // 核心约束检查：同账号不允许再次注册，有且只有一个同名称账号
    const existingAccount = await context.env.DB.prepare(
      "SELECT account_id FROM accounts WHERE account_id = ?"
    ).bind(validation.accountId).first();

    if (existingAccount) {
      return error("ACCOUNT_EXISTS", `账号「${validation.accountId}」已存在，同账号不允许再次注册（系统有且仅能有一个同名称账号）。`, 409);
    }

    const encryptedAccountPassword = await encryptSecret(validation.accountPassword, context.env);
    const encryptedSecret = await encryptSecret(validation.totpSecret, context.env);
    const encryptedGptSecret = validation.gptTotpSecret
      ? await encryptSecret(validation.gptTotpSecret, context.env)
      : null;

    // 插入 accounts 表
    await context.env.DB.prepare(
      `INSERT INTO accounts (
        account_id,
        account_password_encrypted,
        totp_secret_encrypted,
        gpt_totp_secret_encrypted,
        status,
        note,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).bind(
      validation.accountId,
      encryptedAccountPassword,
      encryptedSecret,
      encryptedGptSecret,
      validation.status,
      validation.note || ""
    ).run();

    // 如果指定了初始生成 Token 数量
    const generatedTokens = [];
    if (validation.initialTokensCount > 0) {
      const seenTokens = new Set();
      for (let i = 0; i < validation.initialTokensCount; i += 1) {
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
          validation.accountId,
          encryptedAccountPassword,
          encryptedSecret,
          encryptedGptSecret,
          validation.status
        );
      });

      await context.env.DB.batch(statements);
    }

    return json({
      ok: true,
      message: "账号注册成功",
      accountId: validation.accountId,
      generatedTokensCount: generatedTokens.length,
      tokens: generatedTokens
    });
  } catch (err) {
    return error("SERVER_ERROR", "添加账号失败，请稍后重试: " + err.message, 500);
  }
}

async function handlePut(context) {
  try {
    const body = await readJson(context.request);
    const adminError = await verifyAdminPassword(body.adminPassword, context.env);

    if (adminError) {
      return adminError;
    }

    await ensureAccountsTable(context.env.DB);

    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) {
      return error("BAD_REQUEST", "请指定要编辑的账号 ID", 400);
    }

    const newAccountId = typeof body.newAccountId === "string"
      ? body.newAccountId.trim()
      : accountId;
    if (!newAccountId) {
      return error("BAD_REQUEST", "请填写新的账号 ID", 400);
    }

    const currentAccount = await context.env.DB.prepare(
      "SELECT * FROM accounts WHERE account_id = ?"
    ).bind(accountId).first();

    if (!currentAccount) {
      return error("NOT_FOUND", "指定的账号不存在", 404);
    }

    if (newAccountId !== accountId) {
      const existingAccount = await context.env.DB.prepare(
        "SELECT account_id FROM accounts WHERE account_id = ?"
      ).bind(newAccountId).first();

      if (existingAccount) {
        return error("ACCOUNT_EXISTS", `账号「${newAccountId}」已存在。`, 409);
      }
    }

    const details = [];
    const rawSecret = typeof body.totpSecret === "string" ? body.totpSecret.trim() : "";
    const totpSecret = rawSecret ? rawSecret.replace(/\s+/g, "").toUpperCase() : "";
    const rawGptSecret = typeof body.gptTotpSecret === "string" ? body.gptTotpSecret.trim() : "";
    const gptTotpSecret = rawGptSecret ? rawGptSecret.replace(/\s+/g, "").toUpperCase() : "";
    const accountPassword = typeof body.accountPassword === "string" ? body.accountPassword.trim() : "";
    const status = typeof body.status === "string" && body.status.trim() ? body.status.trim().toLowerCase() : currentAccount.status;
    const note = typeof body.note === "string" ? body.note.trim() : (currentAccount.note || "");
    const syncActiveTokens = body.syncActiveTokens !== false;

    if (totpSecret && !isValidBase32(totpSecret)) {
      details.push({ field: "totp_secret", message: "Google 2FA Base32 密钥格式错误" });
    }

    if (gptTotpSecret && !isValidBase32(gptTotpSecret)) {
      details.push({ field: "gpt_totp_secret", message: "GPT 2FA Base32 密钥格式错误" });
    }

    if (!VALID_STATUSES.has(status)) {
      details.push({ field: "status", message: "状态只能是 active 或 disabled" });
    }

    if (details.length > 0) {
      return error("VALIDATION_FAILED", "修改参数校验失败", 400, { details });
    }

    const encryptedAccountPassword = accountPassword
      ? await encryptSecret(accountPassword, context.env)
      : currentAccount.account_password_encrypted;

    const encryptedTotpSecret = totpSecret
      ? await encryptSecret(totpSecret, context.env)
      : currentAccount.totp_secret_encrypted;

    let encryptedGptTotpSecret = currentAccount.gpt_totp_secret_encrypted;
    if (body.clearGptTotpSecret) {
      encryptedGptTotpSecret = null;
    } else if (gptTotpSecret) {
      encryptedGptTotpSecret = await encryptSecret(gptTotpSecret, context.env);
    }

    const statements = [
      context.env.DB.prepare(
        `UPDATE accounts
         SET account_id = ?,
             account_password_encrypted = ?,
             totp_secret_encrypted = ?,
             gpt_totp_secret_encrypted = ?,
             status = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ?`
      ).bind(
        newAccountId,
        encryptedAccountPassword,
        encryptedTotpSecret,
        encryptedGptTotpSecret,
        status,
        note,
        accountId
      ),
      context.env.DB.prepare(
        `UPDATE tokens
         SET account_id = ?
         WHERE account_id = ?`
      ).bind(newAccountId, accountId)
    ];

    // 如果选择同步更新未使用的 active tokens
    if (syncActiveTokens) {
      statements.push(context.env.DB.prepare(
        `UPDATE tokens
         SET account_password_encrypted = ?,
             totp_secret_encrypted = ?,
             gpt_totp_secret_encrypted = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ? AND status = 'active'`
      ).bind(
        encryptedAccountPassword,
        encryptedTotpSecret,
        encryptedGptTotpSecret,
        newAccountId
      ));
    }

    await context.env.DB.batch(statements);

    return json({
      ok: true,
      message: "账号信息更新成功",
      accountId: newAccountId
    });
  } catch (err) {
    return error("SERVER_ERROR", "修改账号失败: " + err.message, 500);
  }
}

async function handleDelete(context) {
  try {
    const body = await readJson(context.request);
    const adminError = await verifyAdminPassword(body.adminPassword, context.env);

    if (adminError) {
      return adminError;
    }

    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) {
      return error("BAD_REQUEST", "请指定要删除的账号 ID", 400);
    }

    // 删除关联的 tokens
    await context.env.DB.prepare(
      "DELETE FROM tokens WHERE account_id = ?"
    ).bind(accountId).run();

    // 删除 accounts 记录
    const result = await context.env.DB.prepare(
      "DELETE FROM accounts WHERE account_id = ?"
    ).bind(accountId).run();

    return json({
      ok: true,
      message: `账号「${accountId}」及其关联 Token 已成功删除。`,
      changes: result?.meta?.changes || 0
    });
  } catch (err) {
    return error("SERVER_ERROR", "删除账号失败: " + err.message, 500);
  }
}

function validateAccountInput(body) {
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
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const initialTokensCount = Number(body.initialTokensCount || 0);

  if (!accountId) {
    details.push({ field: "account_id", message: "请填写账号 ID / 用户名" });
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

  if (!VALID_STATUSES.has(status)) {
    details.push({ field: "status", message: "状态只能是 active 或 disabled" });
  }

  if (!Number.isInteger(initialTokensCount) || initialTokensCount < 0 || initialTokensCount > 100) {
    details.push({ field: "initial_tokens_count", message: "初始生成数量必须是 0-100 的整数" });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  return {
    ok: true,
    accountId,
    accountPassword,
    totpSecret,
    gptTotpSecret,
    status,
    note,
    initialTokensCount
  };
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
  return `TK-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
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

async function decryptEncryptedValue(encryptedValue, env) {
  const [ivValue, ciphertextValue] = String(encryptedValue || "").split(".");
  const iv = base64ToBytes(ivValue || "");
  const ciphertext = base64ToBytes(ciphertextValue || "");
  const keyBytes = base64ToBytes(env.TOTP_ENCRYPTION_KEY || "");

  if (iv.length !== 12 || ciphertext.length === 0 || keyBytes.length !== 32) {
    throw new Error("Invalid encrypted secret");
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
