const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_PATTERN = /^TK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;
const VALID_STATUSES = new Set(["active", "disabled"]);

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

    if (typeof body.csv !== "string" || !body.csv.trim()) {
      return error("BAD_REQUEST", "请提供 CSV 内容", 400);
    }

    const validation = await validateCsv(body.csv, context.env.DB);

    if (!validation.ok) {
      return error("CSV_VALIDATION_FAILED", "CSV 校验失败", 400, {
        details: validation.details
      });
    }

    const encryptedRows = [];

    for (const row of validation.rows) {
      encryptedRows.push({
        ...row,
        encryptedAccountPassword: await encryptAccountPassword(row.accountPassword, context.env),
        encryptedSecret: await encryptSecret(row.totpSecret, context.env),
        encryptedGptSecret: row.gptTotpSecret ? await encryptSecret(row.gptTotpSecret, context.env) : null
      });
    }

    const seenAccounts = new Map();
    for (const row of encryptedRows) {
      if (!seenAccounts.has(row.accountId)) {
        seenAccounts.set(row.accountId, row);
      }
    }

    const accountStatements = [...seenAccounts.values()].map((row) => {
      return context.env.DB.prepare(
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
        row.accountId,
        row.encryptedAccountPassword,
        row.encryptedSecret,
        row.encryptedGptSecret,
        row.status
      );
    });

    const tokenStatements = encryptedRows.map((row) => {
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
        row.tokenCode,
        row.accountId,
        row.encryptedAccountPassword,
        row.encryptedSecret,
        row.encryptedGptSecret,
        row.status
      );
    });

    const statements = [...accountStatements, ...tokenStatements];

    if (statements.length > 0) {
      await context.env.DB.batch(statements);
    }

    return json({
      ok: true,
      imported: encryptedRows.length,
      generated: encryptedRows.filter((row) => row.generated).length,
      tokens: encryptedRows.map((row) => ({
        tokenCode: row.tokenCode,
        accountId: row.accountId,
        status: row.status,
        generated: row.generated,
        hasGpt2fa: Boolean(row.gptTotpSecret)
      }))
    });
  } catch (err) {
    return error("SERVER_ERROR", "导入失败，请稍后重试", 500);
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

async function validateCsv(csv, db) {
  const parsed = parseCsv(csv);

  if (!parsed.ok) {
    return {
      ok: false,
      details: [parsed.detail]
    };
  }

  const rows = parsed.rows.filter((row, index) => {
    return index === 0 || row.fields.some((field) => field.trim() !== "");
  });
  const details = [];

  if (rows.length === 0) {
    return {
      ok: false,
      details: [{ row: 1, field: "csv", message: "CSV 不能为空" }]
    };
  }

  const headers = rows[0].fields.map((field) => field.trim().toLowerCase());
  const indexes = {
    tokenCode: headers.indexOf("token_code"),
    accountId: headers.indexOf("account_id"),
    accountPassword: headers.indexOf("account_password"),
    totpSecret: headers.indexOf("totp_secret"),
    gptTotpSecret: headers.indexOf("gpt_totp_secret"),
    status: headers.indexOf("status")
  };

  if (indexes.accountId === -1) {
    details.push({ row: rows[0].row, field: "account_id", message: "CSV header 缺少 account_id" });
  }

  if (indexes.accountPassword === -1) {
    details.push({ row: rows[0].row, field: "account_password", message: "CSV header 缺少 account_password" });
  }

  if (indexes.totpSecret === -1) {
    details.push({ row: rows[0].row, field: "totp_secret", message: "CSV header 缺少 totp_secret" });
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  const normalizedRows = [];
  const seenTokens = new Map();

  for (const row of rows.slice(1)) {
    const accountId = readField(row.fields, indexes.accountId).trim();
    const accountPassword = readField(row.fields, indexes.accountPassword).trim();
    const rawSecret = readField(row.fields, indexes.totpSecret).trim();
    const rawGptSecret = indexes.gptTotpSecret === -1 ? "" : readField(row.fields, indexes.gptTotpSecret).trim();
    const rawStatus = indexes.status === -1 ? "" : readField(row.fields, indexes.status).trim();
    const rawToken = indexes.tokenCode === -1 ? "" : readField(row.fields, indexes.tokenCode).trim();
    const status = rawStatus ? rawStatus.toLowerCase() : "active";
    const totpSecret = rawSecret.replace(/\s+/g, "").toUpperCase();
    const gptTotpSecret = rawGptSecret.replace(/\s+/g, "").toUpperCase();
    let tokenCode = rawToken.toUpperCase();
    let generated = false;

    if (!accountId) {
      details.push({ row: row.row, field: "account_id", message: "请填写账号 ID" });
    }

    if (!accountPassword) {
      details.push({ row: row.row, field: "account_password", message: "请填写账号密码" });
    }

    if (!rawSecret) {
      details.push({ row: row.row, field: "totp_secret", message: "请填写 Google 2FA Base32 密钥" });
    } else if (!isValidBase32(totpSecret)) {
      details.push({ row: row.row, field: "totp_secret", message: "Google 2FA Base32 密钥格式错误" });
    }

    if (gptTotpSecret && !isValidBase32(gptTotpSecret)) {
      details.push({ row: row.row, field: "gpt_totp_secret", message: "GPT 2FA Base32 密钥格式错误" });
    }

    if (!VALID_STATUSES.has(status)) {
      details.push({ row: row.row, field: "status", message: "状态只能是 active 或 disabled" });
    }

    if (tokenCode && !TOKEN_PATTERN.test(tokenCode)) {
      details.push({ row: row.row, field: "token_code", message: "token_code 必须符合 TK-XXXX-XXXX-XXXX-XXXX 规范" });
    }

    if (!tokenCode) {
      tokenCode = await generateUniqueToken(db, seenTokens);
      generated = true;
    }

    if (seenTokens.has(tokenCode)) {
      details.push({
        row: row.row,
        field: "token_code",
        message: `token_code 与第 ${seenTokens.get(tokenCode)} 行重复`
      });
    } else {
      seenTokens.set(tokenCode, row.row);
    }

    normalizedRows.push({
      row: row.row,
      tokenCode,
      accountId,
      accountPassword,
      totpSecret,
      gptTotpSecret,
      status,
      generated
    });
  }

  const existingTokens = await findExistingTokens(db, [...seenTokens.keys()]);

  for (const row of normalizedRows) {
    if (existingTokens.has(row.tokenCode)) {
      details.push({
        row: row.row,
        field: "token_code",
        message: "token_code 已存在"
      });
    }
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  return { ok: true, rows: normalizedRows };
}

function parseCsv(csv) {
  const rows = [];
  let fields = [];
  let field = "";
  let inQuotes = false;
  let rowStart = 1;
  let line = 1;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        if (char === "\n") {
          line += 1;
        }
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n") {
      fields.push(field);
      rows.push({ row: rowStart, fields });
      fields = [];
      field = "";
      line += 1;
      rowStart = line;
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      detail: { row: rowStart, field: "csv", message: "CSV 引号未闭合" }
    };
  }

  fields.push(field);
  rows.push({ row: rowStart, fields });

  return { ok: true, rows };
}

function readField(fields, index) {
  return index >= 0 && index < fields.length ? fields[index] : "";
}

function isValidBase32(value) {
  if (!value || !BASE32_PATTERN.test(value)) {
    return false;
  }

  const firstPadding = value.indexOf("=");
  return firstPadding === -1 || /^=+$/.test(value.slice(firstPadding));
}

async function generateUniqueToken(db, seenTokens) {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const tokenCode = generateToken();

    if (!seenTokens.has(tokenCode) && !(await tokenExists(db, tokenCode))) {
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

async function findExistingTokens(db, tokenCodes) {
  const existing = new Set();

  for (const tokenCode of tokenCodes) {
    if (await tokenExists(db, tokenCode)) {
      existing.add(tokenCode);
    }
  }

  return existing;
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

async function encryptAccountPassword(accountPassword, env) {
  return encryptSecret(accountPassword, env);
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
