export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "只支持 GET 请求", 405);
  }

  try {
    const url = new URL(context.request.url);
    const adminError = await verifyAdminPassword(url.searchParams.get("adminPassword"), context.env);

    if (adminError) {
      return adminError;
    }

    const result = await context.env.DB.prepare(
      `SELECT
        token_code,
        account_id,
        totp_secret_encrypted,
        status,
        created_at,
        updated_at
      FROM tokens
      ORDER BY created_at DESC, token_code ASC`
    ).all();

    const tokens = await Promise.all((result.results || []).map(async (row) => ({
        tokenCode: row.token_code,
        accountId: row.account_id,
        totpSecret: await decryptSecret(row.totp_secret_encrypted, context.env),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })));

    return json({
      ok: true,
      tokens
    });
  } catch {
    return error("SERVER_ERROR", "读取 token 列表失败，请稍后重试", 500);
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

async function decryptSecret(encryptedSecret, env) {
  const plaintext = await decryptEncryptedValue(encryptedSecret, env);
  return plaintext.replace(/\s+/g, "").toUpperCase();
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

async function verifyAdminPassword(adminPassword, env) {
  if (typeof adminPassword !== "string" || !adminPassword) {
    return error("UNAUTHORIZED", "管理员密码错误", 401);
  }

  if (!env.ADMIN_PASSWORD_HASH) {
    return error("SERVER_ERROR", "管理员密码未配置", 500);
  }

  const digest = await sha256Hex(adminPassword);

  if (!constantTimeEqual(digest, env.ADMIN_PASSWORD_HASH.toLowerCase())) {
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
