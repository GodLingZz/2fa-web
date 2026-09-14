# 规格：Token 校验与 Cloudflare 部署

## Phase 1：规格定义

### 已确认假设

1. 目标部署方案使用 Cloudflare 免费栈：Pages、Pages Functions、D1。
2. `2fa-verify.html` 继续作为面向用户的公开查询页面。
3. 前端不能包含 token 映射表，也不能包含任何 2FA 密钥。
4. TOTP 验证码由后端生成，不再由浏览器 JavaScript 生成。
5. 管理员 CSV 导入使用简单密码保护：每次管理请求都携带管理员密码。
6. CSV 中的 `totp_secret` 只支持 Base32，不支持 `otpauth://` 链接。
7. Token 成功发放验证码后必须作废，后续再次使用同一 token 应返回已使用错误。
8. 尽量保留现有视觉风格、倒计时、复制按钮和过期锁定体验。

### 目标

把当前本地静态 2FA 测试页升级成可部署的 token 校验系统：

- 管理员可以通过 CSV 批量导入 token 记录。
- 每个 token 对应一个账号和一个 Base32 TOTP 密钥。
- 用户在公开页面输入 Token Code。
- 后端校验 token，并生成当前 6 位 TOTP 验证码。
- 公开页立即展示当前时间片验证码，首码失效后只自动刷新一次第二码，第二码结束后沿用失效锁定状态。
- 前端只展示 6 位验证码，永远不接收底层 TOTP 密钥。

### 成功标准

- `2fa-verify.html` 不再包含 `mockDatabase` 或任何真实 TOTP 密钥。
- 公开 token 校验调用 `POST /api/token/verify`。
- API 响应永远不包含 `totp_secret` 或解密后的密钥内容。
- 有效且启用的 token 在 `mode: "check"` 下返回 `accountId` 和 `accountPassword`，不消耗 token；确认使用后返回 6 位验证码、`accountId`、`timeLeft`、`expiresAt`，并将该 token 标记为 `used`。
- 无效、停用、格式错误或缺失 token 都返回清晰的 JSON 错误。
- 管理员 CSV 导入同时支持有 `token_code` 和没有 `token_code` 的行。
- 空 `token_code` 会被替换为高随机性自动生成 token。
- 管理员可以手动输入账号、Base32 2FA 密钥和数量，批量生成规范 token。
- 系统自动生成的新 token 必须符合 `TK-XXXX-XXXX-XXXX-XXXX` 规范。
- 管理端可以一键导出全部账号和对应未使用 token 的 Excel 文件；当前阶段“未使用”定义为 `status = active`；导出后必须弹窗显示结果和下载地址。
- CSV 导入会拒绝重复 token 和格式错误的 Base32 密钥，并返回具体行号错误。
- 项目可以通过 Wrangler Pages dev 本地运行，并可以部署到 Cloudflare Pages。

### 技术栈

- 前端：静态 HTML、Tailwind CDN、Font Awesome CDN。
- 后端：Cloudflare Pages Functions。
- 数据库：Cloudflare D1。
- 密钥管理：Cloudflare Pages/Workers secrets。
- 加密：Cloudflare Workers 运行时 Web Crypto API。
- TOTP：后端实现 HMAC-SHA1、30 秒周期、6 位验证码。

### 命令

安装和本地开发：

```powershell
npm init -y
npm install -D wrangler
npx wrangler pages dev . --compatibility-date=2025-12-01
```

D1 初始化：

```powershell
npx wrangler d1 create 2fa-token-db
npx wrangler d1 migrations create 2fa-token-db init_tokens
npx wrangler d1 migrations apply 2fa-token-db --local
npx wrangler d1 migrations apply 2fa-token-db --remote
```

Secrets：

```powershell
npx wrangler pages secret put ADMIN_PASSWORD_HASH
npx wrangler pages secret put TOTP_ENCRYPTION_KEY
```

部署：

```powershell
npx wrangler pages deploy .
```

### 项目结构

```text
E:\2FA-Web
├─ 2fa-verify.html
├─ admin.html
├─ admin-console.html
├─ functions/
│  └─ api/
│     ├─ token/
│     │  └─ verify.js
│     └─ admin/
│        ├─ import-csv.js
│        └─ tokens.js
├─ migrations/
│  └─ 0001_init_tokens.sql
├─ docs/
│  └─ token-cloudflare-spec.md
├─ package.json
└─ wrangler.toml
```

### 数据库结构

```sql
CREATE TABLE IF NOT EXISTS tokens (
  token_code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_password_encrypted TEXT,
  totp_secret_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_account_id ON tokens(account_id);
```

### CSV 格式

```csv
token_code,account_id,account_password,totp_secret,status
TK-A7KD-9M2Q-X4ZT-P8CN,user001,DemoPass2026!,IM34ICZWS2TAEM4YK6KNWQNEE6YLPLK6,active
,user002,DemoPass2026!,JBSWY3DPEHPK3PXP,active
```

规则：

- `account_id` 必填。
- `account_password` 必填，写入前使用 AES-GCM 加密，管理列表和导出接口不返回。
- `totp_secret` 必填，并且必须是 Base32。
- Base32 输入会自动去掉首尾空格并转换为大写。
- Base32 允许字符：`A-Z`、`2-7`，以及可选的 `=`。
- `token_code` 可选。缺失时由后端自动生成。
- `status` 可选，默认 `active`。
- 导入时允许的状态：`active`、`disabled`。

### API 约定

#### POST `/api/token/verify`

检查请求：

```json
{
  "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN",
  "mode": "check"
}
```

检查成功：

```json
{
  "ok": true,
  "accountId": "user001",
  "accountPassword": "DemoPass2026!",
  "status": "active"
}
```

确认使用请求：

```json
{
  "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN"
}
```

确认使用成功：

```json
{
  "ok": true,
  "code": "123456",
  "accountId": "user001",
  "timeLeft": 28,
  "expiresAt": 1780000000000
}
```

错误：

```json
{
  "ok": false,
  "error": "TOKEN_NOT_FOUND",
  "message": "Token 不存在或已失效"
}
```

预期错误码：

- `BAD_REQUEST`
- `TOKEN_NOT_FOUND`
- `TOKEN_DISABLED`
- `SECRET_INVALID`
- `SERVER_ERROR`

#### POST `/api/admin/import-csv`

请求：

```json
{
  "adminPassword": "admin password",
  "csv": "token_code,account_id,account_password,totp_secret,status\n..."
}
```

成功：

```json
{
  "ok": true,
  "imported": 2,
  "generated": 1,
  "tokens": [
    {
      "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN",
      "accountId": "user001",
      "status": "active",
      "generated": false
    }
  ]
}
```

校验失败：

```json
{
  "ok": false,
  "error": "CSV_VALIDATION_FAILED",
  "message": "CSV 校验失败",
  "details": [
    {
      "row": 3,
      "field": "totp_secret",
      "message": "请填写 Base32 密钥"
    }
  ]
}
```

#### GET `/api/admin/tokens?adminPassword=...`

成功：

```json
{
  "ok": true,
  "tokens": [
    {
      "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN",
      "accountId": "user001",
      "status": "active",
      "createdAt": "2026-06-15 12:00:00",
      "updatedAt": "2026-06-15 12:00:00"
    }
  ]
}
```

这个接口绝不能返回 `totp_secret`、加密后的 secret 内容或加密元数据。

#### POST `/api/admin/generate-tokens`

请求：

```json
{
  "adminPassword": "admin password",
  "accountId": "user001",
  "accountPassword": "DemoPass2026!",
  "totpSecret": "JBSWY3DPEHPK3PXP",
  "count": 10,
  "status": "active"
}
```

成功：

```json
{
  "ok": true,
  "generated": 10,
  "tokens": [
    {
      "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN",
      "accountId": "user001",
      "status": "active"
    }
  ]
}
```

规则：

- 必须校验管理员密码。
- `accountId`、`accountPassword`、`totpSecret`、`count` 必填。
- `totpSecret` 必须是 Base32，写入前复用 AES-GCM 加密规则。
- `count` 必须是 `1-100` 的整数。
- `status` 可选，默认 `active`，只允许 `active` 或 `disabled`。
- 响应不能返回明文 secret、加密 secret 或加密元数据。

#### GET `/api/admin/export-unused-tokens?adminPassword=...`

返回 Excel `.xlsx` 文件。

规则：

- 必须校验管理员密码。
- 验证码成功发放后 token 会被标记为 `status = used`，因此“未使用 token”定义为 `status = active`。
- 导出内容为全部 active token，一行一个 token。
- Excel 列：`account_id`、`token_code`、`status`、`created_at`。
- 导出文件不能包含 `totp_secret`、加密 secret 或加密元数据。

### 代码风格

重复的 API 行为使用小型 helper：

```js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function error(error, message, status = 400, extra = {}) {
  return json({ ok: false, error, message, ...extra }, status);
}
```

约定：

- D1 字段使用 `snake_case`。
- JavaScript 变量使用 `camelCase`。
- API 错误码使用大写下划线。
- 不记录 `totp_secret`、解密后密钥、管理员密码或加密密钥。
- 所有 D1 查询使用 prepared statements。

### 测试策略

当前项目没有测试框架，先以本地手动/API 级验证为主。

验证命令：

```powershell
npx wrangler pages dev . --compatibility-date=2025-12-01
```

手动检查：

- 打开 `/admin.html`。
- 导入一份包含一个显式 token 和一个空 token 的 CSV。
- 确认自动生成的 token 出现在管理结果中。
- 输入账号、Base32 密钥和数量，确认管理端能手动生成规范 token。
- 点击导出未使用 token，确认弹窗显示导出成功和下载地址；下载的 Excel 只包含账号和 active token 元数据。
- 打开 `/2fa-verify`。
- 输入有效 token，确认出现 6 位验证码。
- 输入无效 token，确认出现用户可理解的错误。
- 搜索前端源码，确认没有 `mockDatabase` 和真实 Base32 测试密钥。
- 检查浏览器网络响应，确认没有 `totp_secret`。

### 边界

始终要做：

- TOTP 密钥只保存在服务端。
- 校验所有管理 API 和公开 API 请求。
- 管理员密码 hash 和加密密钥使用 Cloudflare Secrets。
- API 响应使用 `no-store`。
- 除非 API 改造必须，否则保留当前公开页面视觉设计。

需要先询问：

- 改变一次性 token 的消耗时机或恢复已使用 token。
- 在管理 UI 中增加删除或停用按钮。
- 把“每次请求带管理员密码”的简单模式升级为 session 登录。
- 增加完整构建系统或前端框架。

绝不做：

- 不把真实密钥写进 HTML、JavaScript、文档或提交的配置。
- 不把 TOTP secret 返回给浏览器。
- 不明文存储管理员密码。
- 不提交包含真实值的 `.dev.vars`。
- 不隐藏 CSV 校验错误，必须返回行级错误信息。

## Phase 2：技术计划

### 组件计划

1. Cloudflare 项目基础
   - 新增 `package.json`、`wrangler.toml`、migrations、Pages Functions 目录。
   - 将 D1 绑定命名为 `DB`。
   - 定义必须的 secrets：`ADMIN_PASSWORD_HASH`、`TOTP_ENCRYPTION_KEY`。

2. 后端公共 helper
   - 添加 JSON 响应、管理员密码校验、Base32 校验、token 生成、AES-GCM 加解密、TOTP 生成逻辑。
   - 如果 Pages Functions 的共享导入行为已验证，可以抽成小共享模块；否则先放在各函数文件中，避免部署失败。

3. 管理员导入流程
   - 构建 `/admin.html`。
   - 实现 `/api/admin/import-csv`。
   - 实现 `/api/admin/tokens`。
   - 导入时必须先校验全部行，再插入任何记录。

4. 公开 token 校验流程
   - 实现 `/api/token/verify`。
   - 将前端 `mockDatabase` 查询替换为 API 请求。
   - 保留倒计时、验证码展示、复制和过期状态。

5. 验证与部署文档
   - 使用 Wrangler 本地验证。
   - 如果进入实施，补充 `docs/deployment.md`，记录 Cloudflare 设置和部署命令。

### 实施顺序

1. 创建项目脚手架和 D1 schema。
2. 实现 crypto、Base32、token 和响应 helper。
3. 实现管理员导入和 token 列表 API。
4. 新增 `admin.html`。
5. 实现公开 verify API。
6. 修改 `2fa-verify.html`。
7. 运行本地端到端验证。
8. 补充部署说明。

### 关键技术决策

#### Cloudflare 运行时

- Pages Functions 使用文件路由，函数导出 `onRequest`。
- D1 绑定固定为 `DB`，所有数据库访问都通过 `context.env.DB`。
- `wrangler.toml` 只写非敏感配置和 D1 binding；真实密码、hash、加密密钥不写入仓库文件。
- 本地开发可使用未提交的 `.dev.vars` 注入 secrets。

#### 管理员密码

- `ADMIN_PASSWORD_HASH` 存储管理员密码的 SHA-256 十六进制摘要。
- 管理请求传入 `adminPassword` 后，后端用 Web Crypto `SHA-256` 计算摘要并与 secret 比较。
- 密码校验失败统一返回 `UNAUTHORIZED`，HTTP 状态码为 `401`。
- 任何日志和 API 响应都不能包含管理员明文密码或 hash。

#### TOTP secret 加密

- `TOTP_ENCRYPTION_KEY` 使用 base64 编码的 32 字节 AES-GCM key。
- 写入数据库前，对规范化后的 Base32 secret 使用 AES-GCM 加密。
- 每条记录使用独立随机 12 字节 IV。
- `totp_secret_encrypted` 字段保存 `base64(iv).base64(ciphertext)` 字符串。
- `account_password_encrypted` 使用同一加密格式保存登录密码；公开 `check` 响应只在 token 有效且未消耗时返回明文密码。
- 解密失败时，公开校验接口返回 `SECRET_INVALID`，不暴露加密细节。

#### TOTP 生成

- Base32 解码在后端完成，先移除空白、转大写，再校验字符集。
- 支持末尾 `=` padding；解码时按 RFC 4648 Base32 处理。
- TOTP 参数固定为 HMAC-SHA1、30 秒步长、6 位数字。
- `timeLeft` 按当前 epoch 秒计算，范围为 `1` 到 `30`。
- `expiresAt` 返回当前时间步结束时刻的毫秒时间戳。

#### Token 生成与校验

- 自动生成 token 使用 Web Crypto `getRandomValues`。
- 自动生成 token 的格式固定为 `TK-XXXX-XXXX-XXXX-XXXX`，例如 `TK-A7KD-9M2Q-X4ZT-P8CN`。
- `X` 只能来自无歧义字符集：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。
- 生成逻辑必须在写入前校验自身输出符合规范。
- 允许字符集排除易混淆字符：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。
- 用户输入 token 时先 `trim` 并转大写；空字符串返回 `BAD_REQUEST`。
- 导入时显式 `token_code` 也按同样规则规范化，重复 token 必须拒绝。

#### 管理端手动生成

- 管理入口 `/admin.html` 只提供管理员登录表单。
- 登录成功后跳转 `/admin-console.html`，管理台显示已登录状态和退出按钮。
- 管理台提供手动生成表单：账号 ID、Base32 密钥、生成数量、状态。
- 生成数量限制为 `1-100`。
- 同一次请求生成多个 token 时，同批次内和数据库内都必须唯一。
- 生成出的 token 立即写入 `tokens` 表，并可在公开页使用。
- 手动生成和 CSV 导入共享同一套 Base32 校验、AES-GCM 加密、状态校验和 token 规范。

#### Excel 导出

- 管理台提供“一键导出未使用”按钮。
- 点击导出后先弹窗显示是否成功；成功时弹窗中提供下载地址，用户点击下载地址后进入导出接口。
- 验证码成功发放后 token 会被标记为 `status = used`，因此导出范围为 `status = active` 的 token。
- 导出格式为 `.xlsx`，内容按 `account_id`、`token_code` 排序。
- 导出列为 `account_id`、`token_code`、`status`、`created_at`。
- 不导出 `totp_secret`、加密 secret 或任何加密元数据。

#### CSV 导入

- CSV 第一行必须是 header，字段名至少包含 `account_id`、`account_password`、`totp_secret`。
- `token_code`、`status` 可选；未知列忽略但不报错。
- 支持基础 CSV 引号规则：逗号、换行或双引号可出现在双引号包裹字段中，字段内双引号用 `""` 转义。
- 导入必须先完整解析并校验所有行，再执行任何插入。
- 同一 CSV 内重复 token、数据库已存在 token、非法状态、缺少必填字段、非法 Base32 都返回行级 `details`。
- 有任意行错误时不写入数据库。

#### API 响应与缓存

- 所有 API 响应使用 `application/json; charset=utf-8`。
- 所有 API 响应设置 `cache-control: no-store`。
- 公共校验接口不返回内部密钥细节；停用 token 可返回 `TOKEN_DISABLED`，已使用 token 返回 `TOKEN_USED`。
- 管理列表接口只返回 token 元数据：`tokenCode`、`accountId`、`status`、`createdAt`、`updatedAt`。

#### 前端接入

- 公开页面移除 OTPAuth CDN、`mockDatabase`、`currentSecret` 和浏览器端 TOTP 生成逻辑。
- 用户提交 token 后先调用 `POST /api/token/verify` 的 `mode: "check"` 只检查可用性，不消耗 token。
- 到达真实 TOTP 30 秒边界后再次调用 `POST /api/token/verify` 发放验证码，并在成功响应后消耗 token。
- 成功响应使用服务端返回的 `code`、`timeLeft`、`expiresAt` 驱动展示和倒计时。
- 登录页提供明确登录按钮和登录状态提示；登录成功后跳转到管理台页面。
- 管理台支持 CSV 输入、上传、手动生成、导出未使用 token 和 token 元数据展示，不显示 secret。

### 风险与缓解

- 风险：D1 绑定名称不匹配。
  - 缓解：统一使用 `env.DB`，并在 `wrangler.toml` 中记录绑定。
- 风险：部署后因为加密密钥不同导致已导入 secret 无法解密。
  - 缓解：本地和生产使用同一个稳定 secret 值，并记录密钥生成方式。
- 风险：CSV 中有简单引号或逗号导致解析失败。
  - 缓解：支持基础 CSV 引号，以及被引号包裹字段中的逗号。
- 风险：生成的 TOTP 与认证器 App 不一致。
  - 缓解：使用标准 Base32 解码、HMAC-SHA1、30 秒步长、6 位验证码。
- 风险：`GET /api/admin/tokens` 在 URL query 中携带管理员密码。
  - 缓解：这是当前阶段用户接受的简单方案；API 使用 `no-store`。后续可升级为 POST 或 session。

### 验证检查点

1. migration 能创建 `tokens` 表。
2. 导入接口会拒绝错误管理员密码。
3. 导入接口能导入有效 CSV，并拒绝非法 Base32。
4. token 列表只显示元数据，不显示 secret。
5. verify 接口能为有效 token 返回 6 位验证码。
6. 公开页面不再包含本地 token 数据库。
7. 手动生成接口能生成符合规范的 token，并可用于公开页校验。
8. 导出接口能下载 Excel 文件，且不包含 secret。
9. 浏览器端本地流程完整成功。

## Phase 3：任务拆分

- [x] Task 1：创建 Cloudflare 项目文件
  - 验收：存在 `package.json`、`wrangler.toml`、`functions/`、`migrations/`。
  - 验证：安装后 `npx wrangler --version` 能运行。
  - 文件：`package.json`、`wrangler.toml`、`migrations/0001_init_tokens.sql`

- [x] Task 2：添加 D1 schema migration
  - 验收：定义 `tokens` 表和索引。
  - 验证：`npx wrangler d1 migrations apply 2fa-token-db --local`
  - 文件：`migrations/0001_init_tokens.sql`

- [x] Task 3：实现管理员 CSV 导入 API
  - 验收：必须提供管理员密码；有效 CSV 可导入；无效行返回行级错误。
  - 验证：本地请求 `/api/admin/import-csv`。
  - 文件：`functions/api/admin/import-csv.js`

- [x] Task 4：实现管理员 token 列表 API
  - 验收：必须提供管理员密码；响应只列出 token 元数据。
  - 验证：请求 `/api/admin/tokens?adminPassword=...`，确认没有 secret 字段。
  - 文件：`functions/api/admin/tokens.js`

- [x] Task 5：构建管理页面
  - 验收：管理员可以输入密码、粘贴或上传 CSV、导入并查看 token 列表。
  - 验证：在 Wrangler dev 中打开 `/admin.html` 并导入样例 CSV。
  - 文件：`admin.html`

- [x] Task 6：实现公开 token 校验 API
  - 验收：启用 token 返回当前验证码；缺失或停用 token 返回清晰错误。
  - 验证：使用有效和无效 token 请求 `/api/token/verify`。
  - 文件：`functions/api/token/verify.js`

- [x] Task 7：连接公开页面到 API
  - 验收：`2fa-verify.html` 不再使用 `mockDatabase` 或浏览器端 TOTP secret 生成。
  - 验证：输入已导入 token 后能看到验证码；源码中搜索不到 `mockDatabase`。
  - 文件：`2fa-verify.html`

- [x] Task 8：管理端手动生成与 Excel 导出
  - 验收：管理员通过登录页登录后跳转管理台；管理台可输入账号、2FA 密钥和数量生成多个规范 token；可以一键导出全部账号和 active token 的 Excel 文件。
  - 验证：错误管理员密码被拒绝；非法 Base32 被拒绝；数量超限被拒绝；生成 token 符合 `TK-XXXX-XXXX-XXXX-XXXX`；导出后弹窗显示下载地址；导出的 Excel 不包含 secret。
  - 文件：`functions/api/admin/generate-tokens.js`、`functions/api/admin/export-unused-tokens.js`、`admin.html`、`admin-console.html`、`README.md`

- [ ] Task 9：本地端到端验证
  - 验收：在 `wrangler pages dev` 中完成“管理员导入 -> 用户校验”全流程。
  - 验证：手动跑通管理页和用户页。
  - 文件：除修 bug 外，不要求新增文件。

- [ ] Task 10：补充部署指南
  - 验收：文档记录 D1 创建、secrets、migration、Pages 部署命令。
  - 验证：命令为可复制执行的 PowerShell 命令。
  - 文件：`docs/deployment.md`

## Phase 4：实施规则

实施必须按上面的任务顺序逐个推进。

实施规则：

1. 一次只完成一个任务。
2. 每个任务完成后运行对应验证步骤。
3. 验证失败时不要继续下一个任务。
4. 如果设计决策发生变化，先更新本规格，再改代码。
5. 一次性逻辑已经启用；不要在前端第一次检查 token 时消耗 token。
6. 未经明确同意，不增加前端框架。
7. 不把真实 secrets 写入被版本管理的文件。

本地开发 secrets 应放在版本管理之外，例如 `.dev.vars`：

```text
ADMIN_PASSWORD_HASH=<sha256 hash of admin password>
TOTP_ENCRYPTION_KEY=<base64 32 byte key>
```

`.dev.vars` 不能提交。
