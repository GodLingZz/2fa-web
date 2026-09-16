export async function onRequest(context) {
  const method = context.request.method;

  if (method === "GET") {
    return handleGet(context);
  }

  if (method === "POST" || method === "PATCH") {
    return handleUpdateStatus(context);
  }

  return error("METHOD_NOT_ALLOWED", "不支持的请求方法", 405);
}

async function handleGet(context) {
  try {
    const url = new URL(context.request.url);
    const adminError = await verifyAdminPassword(url.searchParams.get("adminPassword"), context.env);

    if (adminError) {
      return adminError;
    }

    const accountId = (url.searchParams.get("accountId") || "").trim();
    if (!accountId) {
      return error("BAD_REQUEST", "缺少参数 accountId", 400);
    }

    const statusFilter = (url.searchParams.get("status") || "").trim().toLowerCase();

    let query = `
      SELECT
        token_code,
        account_id,
        status,
        created_at,
        updated_at
      FROM tokens
      WHERE account_id = ?
    `;
    const params = [accountId];

    if (statusFilter && statusFilter !== "all") {
      query += " AND status = ?";
      params.push(statusFilter);
    }

    const limit = parseInt(url.searchParams.get("limit") || "0", 10);

    if (statusFilter === "active") {
      query += " ORDER BY created_at ASC, token_code ASC";
    } else {
      query += " ORDER BY created_at DESC, token_code ASC";
    }

    if (limit > 0) {
      query += " LIMIT ?";
      params.push(limit);
    }

    const result = await context.env.DB.prepare(query).bind(...params).all();

    const tokens = (result.results || []).map((row) => ({
      tokenCode: row.token_code,
      accountId: row.account_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      usedAt: row.status === "used" ? row.updated_at : null
    }));

    return json({
      ok: true,
      accountId,
      total: tokens.length,
      tokens
    });
  } catch (err) {
    return error("SERVER_ERROR", "读取账号 Token 列表失败: " + err.message, 500);
  }
}

async function handleUpdateStatus(context) {
  try {
    const body = await readJson(context.request);
    const adminError = await verifyAdminPassword(body.adminPassword, context.env);

    if (adminError) {
      return adminError;
    }

    const tokenCode = typeof body.tokenCode === "string" ? body.tokenCode.trim().toUpperCase() : "";
    const nextStatus = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";

    if (!tokenCode) {
      return error("BAD_REQUEST", "缺少 tokenCode", 400);
    }

    if (!["active", "disabled", "used"].includes(nextStatus)) {
      return error("BAD_REQUEST", "目标状态无效", 400);
    }

    const result = await context.env.DB.prepare(
      `UPDATE tokens
       SET status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE token_code = ?`
    ).bind(nextStatus, tokenCode).run();

    if (result?.meta?.changes === 0) {
      return error("NOT_FOUND", "未找到指定 Token", 404);
    }

    return json({
      ok: true,
      tokenCode,
      status: nextStatus,
      message: `Token 状态已变更为 ${nextStatus}`
    });
  } catch (err) {
    return error("SERVER_ERROR", "更新 Token 状态失败: " + err.message, 500);
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
