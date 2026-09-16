import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/token/verify.js";

const TEST_ENV = {
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } })
      })
    })
  }
};

function createMockRequest(body) {
  return new Request("https://example.com/api/token/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("check mode detects virtual token hasGpt2fa = true", async () => {
  const req = createMockRequest({ tokenCode: "999888", mode: "check" });
  const res = await onRequest({ request: req, env: TEST_ENV });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.hasGpt2fa, true);
  assert.equal(data.accountId, "dev_vip_user@example.com");
});

test("initial verification issues sessionTicket and Google TOTP", async () => {
  const req = createMockRequest({ tokenCode: "999888", step: "google" });
  const res = await onRequest({ request: req, env: TEST_ENV });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.step, "google");
  assert.match(data.code, /^\d{6}$/);
  assert.equal(typeof data.sessionTicket, "string");
  assert.ok(data.sessionTicket.length > 20);
});

test("second step with sessionTicket returns GPT TOTP", async () => {
  // 1. 获取 ticket
  const req1 = createMockRequest({ tokenCode: "999888", step: "google" });
  const res1 = await onRequest({ request: req1, env: TEST_ENV });
  const data1 = await res1.json();
  const ticket = data1.sessionTicket;

  // 2. 用 ticket 获取 gpt 验证码
  const req2 = createMockRequest({ sessionTicket: ticket, step: "gpt" });
  const res2 = await onRequest({ request: req2, env: TEST_ENV });
  const data2 = await res2.json();

  assert.equal(res2.status, 200);
  assert.equal(data2.ok, true);
  assert.equal(data2.step, "gpt");
  assert.match(data2.code, /^\d{6}$/);
  assert.equal(data2.accountId, "dev_vip_user@example.com");
});
