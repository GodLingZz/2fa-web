import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onRequest as accountsEndpoint } from "../functions/api/admin/accounts.js";
import { onRequest as accountTokensEndpoint } from "../functions/api/admin/account-tokens.js";
import { onRequest as accountGenerateTokensEndpoint } from "../functions/api/admin/account-generate-tokens.js";

const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
// sha256 of "admin123"
const ADMIN_HASH = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9";

function createMockEnv() {
  const accountsTable = new Map();
  const tokensTable = new Map();

  return {
    ADMIN_PASSWORD_HASH: ADMIN_HASH,
    TOTP_ENCRYPTION_KEY: TEST_KEY,
    DB: {
      batch: async (statements) => {
        for (const s of statements) {
          if (s && typeof s.run === "function") await s.run();
        }
        return [];
      },
      prepare: (sql) => {
        const query = sql.trim();
        const execute = (...args) => ({
          first: async () => {
            if (query.includes("FROM accounts WHERE account_id = ?")) {
              const id = args[0];
              return accountsTable.get(id) || null;
            }
            if (query.includes("SELECT token_code FROM tokens WHERE token_code = ?")) {
              const code = args[0];
              return tokensTable.get(code) || null;
            }
            return null;
          },
          all: async () => {
            if (query.includes("FROM accounts")) {
              return { results: [...accountsTable.values()] };
            }
            if (query.includes("token_code") && query.includes("GROUP BY account_id")) {
              const map = new Map();
              for (const t of tokensTable.values()) {
                if (t.status === "active" && !map.has(t.account_id)) {
                  map.set(t.account_id, { account_id: t.account_id, token_code: t.token_code });
                }
              }
              return { results: [...map.values()] };
            }
            if (query.includes("GROUP BY account_id")) {
              const counts = new Map();
              for (const t of tokensTable.values()) {
                if (!counts.has(t.account_id)) {
                  counts.set(t.account_id, { total_tokens: 0, active_tokens: 0, used_tokens: 0, disabled_tokens: 0 });
                }
                const stat = counts.get(t.account_id);
                stat.total_tokens++;
                if (t.status === "active") stat.active_tokens++;
                if (t.status === "used") stat.used_tokens++;
                if (t.status === "disabled") stat.disabled_tokens++;
              }
              const results = [...counts.entries()].map(([account_id, v]) => ({ account_id, ...v }));
              return { results };
            }
            if (query.includes("FROM tokens") && query.includes("account_id = ?")) {
              const accountId = args[0];
              let results = [...tokensTable.values()].filter(t => t.account_id === accountId);
              if (query.includes("LIMIT ?")) {
                const lim = args[args.length - 1];
                results = results.slice(0, lim);
              }
              return { results };
            }
            return { results: [] };
          },
          run: async () => {
            if (query.includes("INSERT INTO tokens")) {
              const [token_code, account_id, encPass, encTotp, encGptTotp, status] = args;
              tokensTable.set(token_code, {
                token_code,
                account_id,
                status: status || "active",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
              return { meta: { changes: 1 } };
            }
            if (query.includes("INSERT INTO accounts")) {
              const [account_id, account_password_encrypted, totp_secret_encrypted, gpt_totp_secret_encrypted, status, note] = args;
              accountsTable.set(account_id, {
                account_id,
                account_password_encrypted,
                totp_secret_encrypted,
                gpt_totp_secret_encrypted,
                status,
                note,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
              return { meta: { changes: 1 } };
            }
            if (query.includes("UPDATE accounts")) {
              const [nextAccountId, pass, totp, gptTotp, status, note, account_id] = args;
              const acc = accountsTable.get(account_id);
              if (acc) {
                accountsTable.delete(account_id);
                acc.account_id = nextAccountId;
                acc.account_password_encrypted = pass;
                acc.totp_secret_encrypted = totp;
                acc.gpt_totp_secret_encrypted = gptTotp;
                acc.status = status;
                acc.note = note;
                acc.updated_at = new Date().toISOString();
                accountsTable.set(nextAccountId, acc);
              }
              return { meta: { changes: 1 } };
            }
            if (query.includes("DELETE FROM accounts WHERE account_id = ?")) {
              const id = args[0];
              accountsTable.delete(id);
              return { meta: { changes: 1 } };
            }
            if (query.includes("DELETE FROM tokens WHERE account_id = ?")) {
              const id = args[0];
              for (const [k, v] of tokensTable.entries()) {
                if (v.account_id === id) tokensTable.delete(k);
              }
              return { meta: { changes: 1 } };
            }
            if (query.includes("UPDATE tokens") && query.includes("SET account_id = ?")) {
              const [nextAccountId, accountId] = args;
              for (const token of tokensTable.values()) {
                if (token.account_id === accountId) token.account_id = nextAccountId;
              }
              return { meta: { changes: 1 } };
            }
            if (query.includes("UPDATE tokens") && query.includes("SET status = ?")) {
              const [status, tokenCode] = args;
              const token = tokensTable.get(tokenCode);
              if (token) token.status = status;
              return { meta: { changes: token ? 1 : 0 } };
            }
            if (query.includes("UPDATE tokens")) {
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          }
        });

        const rootExec = execute();
        return {
          ...rootExec,
          bind: (...args) => execute(...args)
        };
      }
    }
  };
}

test("register account creates new account and enforces uniqueness", async () => {
  const env = createMockEnv();

  // 1. First registration should succeed
  const createReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "vip_user_01",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      gptTotpSecret: "JBSWY3DPEHPK3PXQ",
      status: "active",
      note: "测试账号1"
    })
  });

  const res1 = await accountsEndpoint({ request: createReq, env });
  const data1 = await res1.json();

  assert.equal(res1.status, 200);
  assert.equal(data1.ok, true);
  assert.equal(data1.accountId, "vip_user_01");

  // 2. Duplicate registration with same accountId MUST be rejected (409 Conflict)
  const dupReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "vip_user_01",
      accountPassword: "AnotherPassword123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      status: "active"
    })
  });

  const res2 = await accountsEndpoint({ request: dupReq, env });
  const data2 = await res2.json();

  assert.equal(res2.status, 409);
  assert.equal(data2.ok, false);
  assert.equal(data2.error, "ACCOUNT_EXISTS");
  assert.match(data2.message, /已存在/);
});

test("accounts GET endpoint returns accounts with decrypted credentials and token stats", async () => {
  const env = createMockEnv();

  // Create an account first
  const createReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "vip_user_02",
      accountPassword: "SecretPassword999!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      gptTotpSecret: "JBSWY3DPEHPK3PXQ",
      status: "active",
      note: "VIP用户"
    })
  });
  await accountsEndpoint({ request: createReq, env });

  // Read accounts list
  const getReq = new Request("https://example.com/api/admin/accounts?adminPassword=admin123", {
    method: "GET"
  });
  const res = await accountsEndpoint({ request: getReq, env });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].accountId, "vip_user_02");
  assert.equal(data.accounts[0].accountPassword, "SecretPassword999!");
  assert.equal(data.accounts[0].totpSecret, "JBSWY3DPEHPK3PXP");
  assert.equal(data.accounts[0].gptTotpSecret, "JBSWY3DPEHPK3PXQ");
  assert.equal(data.accounts[0].status, "active");
});

test("renaming an account updates all of its tokens regardless of status", async () => {
  const env = createMockEnv();
  const createReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "before_rename",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      initialTokensCount: 3
    })
  });
  const createRes = await accountsEndpoint({ request: createReq, env });
  const created = await createRes.json();

  for (const [index, status] of ["active", "used", "disabled"].entries()) {
    const statusReq = new Request("https://example.com/api/admin/account-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminPassword: "admin123", tokenCode: created.tokens[index], status })
    });
    const statusRes = await accountTokensEndpoint({ request: statusReq, env });
    assert.equal(statusRes.status, 200);
  }

  const renameReq = new Request("https://example.com/api/admin/accounts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "before_rename",
      newAccountId: "after_rename",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      status: "active",
      note: "已改名",
      syncActiveTokens: false
    })
  });
  const renameRes = await accountsEndpoint({ request: renameReq, env });
  const renameData = await renameRes.json();

  assert.equal(renameRes.status, 200);
  assert.equal(renameData.ok, true);

  const getReq = new Request("https://example.com/api/admin/accounts?adminPassword=admin123");
  const getRes = await accountsEndpoint({ request: getReq, env });
  const accountData = await getRes.json();
  assert.equal(accountData.accounts.length, 1);
  assert.equal(accountData.accounts[0].accountId, "after_rename");

  const tokensReq = new Request("https://example.com/api/admin/account-tokens?adminPassword=admin123&accountId=after_rename&status=all");
  const tokensRes = await accountTokensEndpoint({ request: tokensReq, env });
  const tokenData = await tokensRes.json();
  assert.deepEqual(tokenData.tokens.map(token => token.accountId), ["after_rename", "after_rename", "after_rename"]);
  assert.deepEqual(new Set(tokenData.tokens.map(token => token.status)), new Set(["active", "used", "disabled"]));
});

test("renaming an account to an existing ID returns a conflict without changing either account", async () => {
  const env = createMockEnv();

  for (const accountId of ["rename_source", "rename_target"]) {
    const createReq = new Request("https://example.com/api/admin/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminPassword: "admin123",
        accountId,
        accountPassword: "Password123!",
        totpSecret: "JBSWY3DPEHPK3PXP",
        initialTokensCount: 1
      })
    });
    const createRes = await accountsEndpoint({ request: createReq, env });
    assert.equal(createRes.status, 200);
  }

  const renameReq = new Request("https://example.com/api/admin/accounts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "rename_source",
      newAccountId: "rename_target",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      status: "active"
    })
  });
  const renameRes = await accountsEndpoint({ request: renameReq, env });
  const renameData = await renameRes.json();

  assert.equal(renameRes.status, 409);
  assert.equal(renameData.error, "ACCOUNT_EXISTS");

  const sourceTokensReq = new Request("https://example.com/api/admin/account-tokens?adminPassword=admin123&accountId=rename_source");
  const sourceTokensRes = await accountTokensEndpoint({ request: sourceTokensReq, env });
  const sourceTokens = await sourceTokensRes.json();
  assert.equal(sourceTokens.tokens.length, 1);
  assert.equal(sourceTokens.tokens[0].accountId, "rename_source");

  const targetTokensReq = new Request("https://example.com/api/admin/account-tokens?adminPassword=admin123&accountId=rename_target");
  const targetTokensRes = await accountTokensEndpoint({ request: targetTokensReq, env });
  const targetTokens = await targetTokensRes.json();
  assert.equal(targetTokens.tokens.length, 1);
  assert.equal(targetTokens.tokens[0].accountId, "rename_target");

  const getReq = new Request("https://example.com/api/admin/accounts?adminPassword=admin123");
  const getRes = await accountsEndpoint({ request: getReq, env });
  const accountData = await getRes.json();
  assert.deepEqual(new Set(accountData.accounts.map(account => account.accountId)), new Set(["rename_source", "rename_target"]));
});

test("account edit form allows changing the ID and sends both current and new IDs", async () => {
  const html = await readFile(new URL("../admin-console.html", import.meta.url), "utf8");
  const editAccountIdInput = html.match(/<input id="editAccountId"([^>]*)>/)?.[1] || "";

  assert.notEqual(editAccountIdInput, "");
  assert.doesNotMatch(editAccountIdInput, /\breadonly\b/i);
  assert.match(html, /currentEditAccountId/);
  assert.match(html, /accountId:\s*currentEditAccountId,\s*newAccountId,/);
});

test("account-tokens GET returns tokens belonging to specific account and supports limit=1", async () => {
  const env = createMockEnv();

  // Create an account with 2 initial tokens
  const createReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "user_with_tokens",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP",
      initialTokensCount: 2
    })
  });
  await accountsEndpoint({ request: createReq, env });

  // Read accounts list to check firstActiveToken
  const getAccReq = new Request("https://example.com/api/admin/accounts?adminPassword=admin123", {
    method: "GET"
  });
  const accRes = await accountsEndpoint({ request: getAccReq, env });
  const accData = await accRes.json();
  assert.equal(accData.accounts[0].activeTokens, 2);
  assert.ok(accData.accounts[0].firstActiveToken, "firstActiveToken should be present");
  assert.match(accData.accounts[0].firstActiveToken, /^TK-/);

  // Query tokens for this account with limit=1
  const getTokensReq = new Request("https://example.com/api/admin/account-tokens?adminPassword=admin123&accountId=user_with_tokens&limit=1", {
    method: "GET"
  });
  const res = await accountTokensEndpoint({ request: getTokensReq, env });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.accountId, "user_with_tokens");
  assert.equal(Array.isArray(data.tokens), true);
  assert.equal(data.tokens.length, 1);
});

test("accounts DELETE removes account and its tokens", async () => {
  const env = createMockEnv();

  // Create account
  const createReq = new Request("https://example.com/api/admin/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "to_delete_user",
      accountPassword: "Password123!",
      totpSecret: "JBSWY3DPEHPK3PXP"
    })
  });
  await accountsEndpoint({ request: createReq, env });

  // Delete account
  const delReq = new Request("https://example.com/api/admin/accounts", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminPassword: "admin123",
      accountId: "to_delete_user"
    })
  });
  const res = await accountsEndpoint({ request: delReq, env });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);

  // Check it is deleted
  const getReq = new Request("https://example.com/api/admin/accounts?adminPassword=admin123", {
    method: "GET"
  });
  const getRes = await accountsEndpoint({ request: getReq, env });
  const getData = await getRes.json();
  assert.equal(getData.accounts.some(a => a.accountId === "to_delete_user"), false);
});

