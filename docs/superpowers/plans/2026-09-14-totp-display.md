# TOTP 验证码即时展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让公开 2FA 页面立即显示当前标准 TOTP，自动刷新一次第二码并在第二码结束后复用现有失效 UI。

**Architecture:** 保持 Cloudflare Pages Function `/api/token/verify` 和标准 TOTP 算法不变，只重构 `2fa-verify.html` 的前端展示会话。用 `expiresAt` 驱动绝对时间倒计时，用会话 ID 和一次性刷新标记保证最多展示两个码且旧异步请求不能污染新会话。

**Tech Stack:** 静态 HTML/原生 JavaScript、Cloudflare Pages Functions、Cloudflare D1、Node.js `node:test`、Playwright/浏览器自动化、Wrangler Pages Direct Upload。

## Global Constraints

- 必须兼容标准 TOTP 30 秒时间片，首码不延长真实有效期。
- 首码立即展示；首码失效后只自动刷新一次第二码。
- 第二码结束后沿用现有 `lockExpiredCode()` 失效表现。
- 不在前端保存、暴露或生成 TOTP secret。
- 所有新增界面文案使用简体中文。
- 不改数据库迁移、Token 消费语义或管理端接口。

---

### Task 1: 建立可验证的时间计算测试

**Files:**
- Create: `tests/totp-display.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces pure helper contract `getRemainingSeconds(expiresAt, now)` and `shouldRefresh(session, now)`，供页面内逻辑保持同一规则。

- [ ] **Step 1: Write the failing test**

在 `tests/totp-display.test.mjs` 中测试：`expiresAt` 前向上取整得到剩余秒数；过期返回 0；第一码过期允许刷新且刷新后不再允许第三次刷新。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { getRemainingSeconds, shouldRefresh } from "../scripts/totp-display.mjs";

test("remaining seconds follows absolute expiry time", () => {
  assert.equal(getRemainingSeconds(30_000, 1_001), 29);
  assert.equal(getRemainingSeconds(30_000, 30_000), 0);
});

test("only the first expiry may trigger one refresh", () => {
  assert.equal(shouldRefresh({ refreshCount: 0, phase: "first" }, 0), true);
  assert.equal(shouldRefresh({ refreshCount: 1, phase: "second" }, 0), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/totp-display.test.mjs`

Expected: FAIL because `scripts/totp-display.mjs` and the exported helpers do not exist yet.

- [ ] **Step 3: Write minimal helper implementation**

Create `scripts/totp-display.mjs` with exact exports:

```js
export function getRemainingSeconds(expiresAt, now = Date.now()) {
  return Math.max(0, Math.ceil((Number(expiresAt) - Number(now)) / 1000));
}

export function shouldRefresh(session) {
  return session.phase === "first" && session.refreshCount === 0;
}
```

Add a test script in `package.json`: `"test": "node --test tests/*.test.mjs"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/totp-display.test.mjs`

Expected: 2 passing tests, 0 failures.

- [ ] **Step 5: Commit**

```powershell
git add package.json scripts/totp-display.mjs tests/totp-display.test.mjs
git commit -m "test: define TOTP display timing rules"
```

### Task 2: Replace boundary wait with two-code absolute-expiry session

**Files:**
- Modify: `2fa-verify.html:360-540`
- Modify: `2fa-verify.html:578-650`

**Interfaces:**
- Consumes: `requestTokenCode(tokenCode)` response `{ code, timeLeft, expiresAt }` and helpers from `scripts/totp-display.mjs` copied into the inline page runtime through equivalent local functions.
- Produces: immediate first-code display; one automatic second-code refresh; existing `lockExpiredCode()` final state.

- [ ] **Step 1: Write the failing browser assertion**

Add a Playwright check script that intercepts `/api/token/verify`, returns `timeLeft: 12` and a future `expiresAt`, clicks the confirmation flow, and asserts the waiting zone never becomes visible and the code zone shows the first code immediately. Add a second response with a distinct code and assert only one refresh occurs.

- [ ] **Step 2: Run the browser assertion to verify it fails**

Run the local Pages dev server and the browser test. Expected failure: the current page enters `waitingZone` and does not request the first code until the next 00/30 boundary.

- [ ] **Step 3: Implement the minimal page flow**

Change confirmation handler from `startWaitingRoom(getSecondsToNextTotpBoundary(), ...)` to `startCodeSession(checkedToken, sessionId)`. Implement:

```js
async function startCodeSession(token, sessionId) {
  try {
    const result = await requestTokenCode(token);
    if (sessionId !== activeSessionId) return;
    showCodeAndStartTimer(result.code, result.expiresAt, sessionId, 0);
  } catch (error) {
    if (sessionId !== activeSessionId) return;
    alert(error.message || "生成验证码失败，请重新输入授权码。");
    resetToInput();
  }
}
```

Update `showCodeAndStartTimer` to compute `timeLeft` from `expiresAt - Date.now()`, track `phase` and `refreshCount`, and on first expiry call `requestTokenCode` once. On second expiry call `lockExpiredCode()` without another request. Every timer callback must first compare `sessionId` with `activeSessionId`.

- [ ] **Step 4: Run browser assertion to verify it passes**

Run the same Playwright check. Expected: first response displays immediately; expiry triggers exactly one second request; second response displays; final expiry locks the code.

- [ ] **Step 5: Commit**

```powershell
git add 2fa-verify.html
git commit -m "feat: show current TOTP immediately and refresh once"
```

### Task 3: Update Chinese copy and deterministic tests

**Files:**
- Modify: `2fa-verify.html:225-255`
- Modify: `README.md`
- Modify: `docs/token-cloudflare-spec.md`
- Test: `tests/totp-display.test.mjs`

**Interfaces:**
- Consumes: the two-phase display behavior from Task 2.
- Produces: copy that no longer promises a pre-boundary wait and regression coverage for first/second/final states.

- [ ] **Step 1: Write the failing assertions**

Assert source copy no longer contains “距离发放新口令还有” as the primary flow and document that the first code may have fewer than 30 seconds while the second code is the final full window.

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `npm test`

Expected: FAIL against the old waiting-room copy/behavior.

- [ ] **Step 3: Update copy and regression cases**

Use concise Simplified Chinese: “验证码已生成，请在倒计时结束前完成输入；失效后将自动刷新一次验证码。” Keep existing final expired labels unchanged. Add tests for `getRemainingSeconds` across a boundary and the no-third-refresh rule.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: all Node tests pass with 0 failures.

- [ ] **Step 5: Commit**

```powershell
git add 2fa-verify.html README.md docs/token-cloudflare-spec.md tests/totp-display.test.mjs
git commit -m "docs: describe immediate TOTP display lifecycle"
```

### Task 4: Local Playwright self-check and production deployment

**Files:**
- Create: `tests/e2e/totp-display.spec.mjs`

**Interfaces:**
- Consumes: local Pages app and production URL `https://2fa-verify.pages.dev/2fa-verify`.
- Produces: recorded local and production HTTP/browser evidence; no production test token is consumed.

- [ ] **Step 1: Run local Pages dev**

Run: `npm run dev -- --port 8788` and wait for `http://127.0.0.1:8788/2fa-verify` to return HTTP 200.

- [ ] **Step 2: Run Playwright checks**

Use the installed browser automation or `npx playwright` to assert: page 200; placeholder is `输入Token：TK-XXXX`; confirm dialog opens; mocked verify responses produce immediate first code, one refresh, and final expired state; no third request occurs.

- [ ] **Step 3: Run production smoke checks before deploy**

Fetch `https://2fa-verify.pages.dev/2fa-verify`, `/admin`, `/admin-console`, and POST an unknown token to `/api/token/verify`; expect 200 for pages and `TOKEN_NOT_FOUND` for the API.

- [ ] **Step 4: Deploy the verified tree**

Run: `npx wrangler pages deploy . --project-name 2fa-verify --branch main` using the existing Cloudflare authentication/configuration from the deployment setup.

- [ ] **Step 5: Run production Playwright smoke check**

Open `https://2fa-verify.pages.dev/2fa-verify`, assert HTTP 200, assert the new Chinese placeholder and absence of the old boundary-wait text, and verify the page has no console errors during initial load.

- [ ] **Step 6: Commit deployment/test artifacts**

```powershell
git add tests/e2e/totp-display.spec.mjs
git commit -m "test: verify TOTP display flow locally and in production"
```

### Task 5: Publish source to GitHub

**Files:**
- Modify: `.git/config` through Git commands only

**Interfaces:**
- Consumes: all verified commits from Tasks 1-4.
- Produces: a GitHub repository under `GodLingZz` containing the project and the final commit SHA.

- [ ] **Step 1: Initialize and inspect repository state**

Run `git init -b main`, configure the existing user identity, and confirm no unintended secrets are tracked (`.dev.vars` must remain ignored/untracked).

- [ ] **Step 2: Create or select the project repository**

Because `GodLingZz/2FA-Web` does not exist and `pindou-pattern-assistant` is unrelated, create `GodLingZz/2fa-web` as the project repository with `gh repo create GodLingZz/2fa-web --public --source . --remote origin`.

- [ ] **Step 3: Commit and push**

Run `git add -A`, `git commit -m "feat: immediate TOTP display lifecycle"` if no commit exists for the final tree, then `git push -u origin main`.

- [ ] **Step 4: Verify remote state**

Run `git status --short --branch`, `git log -1 --oneline`, and `gh api repos/GodLingZz/2fa-web/commits/main --jq '.sha'`. Expected: clean branch tracking `origin/main`, remote SHA equals local HEAD.
