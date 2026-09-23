# 注册后修改账号 ID 实现计划

> **For agentic workers:** 本计划在当前会话内按步骤执行，不拆分子代理。每项用 checkbox 跟踪。

**Goal:** 允许管理员在账号注册后修改账号 ID，并将所有现有关联 Token 一并改名。

**Architecture:** 沿用 `PUT /api/admin/accounts`。请求同时传当前 ID 与目标 ID；服务端验证目标唯一后，以 Cloudflare D1 batch 原子更新 accounts 和 tokens。前端编辑弹窗提交两个 ID，成功后重新加载列表。

**Tech Stack:** Cloudflare Pages Functions、D1、原生 HTML/JavaScript、Node.js `node:test`。

## Global Constraints

- 所有新增界面文案使用简体中文。
- Token 的账号归属改名需要覆盖 active、used、disabled 全部状态。
- 已有的“同步可用 Token”选项只控制密码和 2FA 密钥，不控制账号 ID 改名。
- 只暂存和提交本功能涉及文件；保留现有未跟踪文件。

---

### Task 1: 覆盖账号改名 API 的成功和冲突行为

**Files:**
- Modify: `tests/account-management.test.mjs`
- Modify: `functions/api/admin/accounts.js`

**Interfaces:**
- `PUT /api/admin/accounts` 接收 `accountId`（当前 ID）与 `newAccountId`（目标 ID）。
- 改名冲突返回 HTTP 409 和 `ACCOUNT_EXISTS`；账号缺失仍返回 HTTP 404。

- [ ] 在 `tests/account-management.test.mjs` 增加测试：注册一个含初始 Token 的账号，另补 used 与 disabled Token；PUT 改名后断言 accounts 和三种状态的 Token 均使用新 ID。
- [ ] 增加冲突测试：注册两个账号，尝试将第一个改为第二个 ID；断言返回 409，两个账号及其 Token 归属未改变。
- [ ] 扩展现有 D1 mock，使 `batch()` 能执行两条账号/Token 更新语句；更新 accounts map 主键，并按 `account_id` 更新 tokens。
- [ ] 运行 `node --test tests/account-management.test.mjs`，确认新增行为测试在实现前失败。
- [ ] 在 `handlePut` 中校验 `newAccountId` 非空；若目标 ID 不等于当前 ID，查询是否已被其他账号占用，冲突时返回 `ACCOUNT_EXISTS`。
- [ ] 用同一个 `DB.batch([...])` 更新 accounts 的主键字段及全部 tokens 的 `account_id`，并在同一批次更新现有资料字段，保证改名不会部分写入。
- [ ] 验证 `node --test tests/account-management.test.mjs` 通过。

### Task 2: 允许在编辑弹窗中修改账号 ID

**Files:**
- Modify: `admin-console.html`

**Interfaces:**
- 编辑表单的 `editAccountId` 保存目标 ID；独立变量 `currentEditAccountId` 保留原 ID供 API 定位。
- 保存成功后保持现有账号与 Token 列表刷新行为。

- [ ] 将 `editAccountId` 的 `readonly` 移除，并在弹窗说明中提示账号 ID 可修改且必须唯一。
- [ ] `openEditModal(account)` 同时记录当前账号 ID 到 `currentEditAccountId` 并填入可编辑字段。
- [ ] `saveEditAccount()` 将 `accountId: currentEditAccountId` 与 `newAccountId: els.editAccountId.value.trim()` 一起发送；服务端字段错误时继续显示现有错误提示。
- [ ] 运行 `npm test`，检查现有及新增 API 测试无回归。
- [ ] `git diff --check`，检查本次改动并确认工作树中仅包含本功能文件和原有未跟踪文件。

### Task 3: 提交并部署

**Files:**
- Commit: `tests/account-management.test.mjs`
- Commit: `functions/api/admin/accounts.js`
- Commit: `admin-console.html`

- [ ] 使用仅包含上述三个文件的提交，提交信息为 `feat: allow editing registered account IDs`。
- [ ] 通过已登录的 Wrangler 身份部署 Cloudflare Pages 项目 `2fa-verify`，执行 `npx wrangler pages deploy . --project-name 2fa-verify --branch main`。
- [ ] 确认 Wrangler 返回部署成功，再请求正式站点 `/admin-console` 验证 HTTP 200，并检查最近部署记录。
- [ ] 如果本机 Wrangler 没有有效登录凭证，停止部署并报告需要重新登录；不得从仓库文档读取或复用其中暴露的 API Token。
