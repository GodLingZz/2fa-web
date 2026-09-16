# 2FA-Web

一个基于 Cloudflare Pages Functions 和 Cloudflare D1 的 2FA Token 验证项目。

项目目标是把原本写在静态页面里的 token 与 TOTP 生成逻辑迁移到服务端：用户只输入 Token Code，服务端从 D1 查询对应账号、加密保存的登录密码与 Base32 TOTP secret，先展示登录指引，再生成当前 6 位验证码并返回给前端。浏览器端不应保存或暴露真实 TOTP secret。

## 当前状态

- `admin.html` 是管理端登录页，登录成功后进入 `admin-console.html`。
- `admin-console.html` 已接入管理接口，可通过 CSV 导入 token、手动生成 token、导出未使用 token，并查看 token 元数据列表。
- `functions/api/admin/import-csv.js` 已实现 CSV 导入、管理员密码校验、Base32 校验、token 自动生成、账号密码加密存储和 secret 加密存储。
- `functions/api/admin/generate-tokens.js` 已实现管理端手动生成 token：输入账号、账号密码、Base32 2FA 密钥和数量后批量生成规范 token。
- `functions/api/admin/export-unused-tokens.js` 已实现未使用 token 的 Excel 导出；当前阶段“未使用”定义为 `status = active`，管理台会在导出成功后弹窗显示下载地址。
- `functions/api/admin/tokens.js` 已实现 token 元数据列表接口，不返回 secret。
- `functions/api/token/verify.js` 已实现公开 token 校验接口，可返回当前 6 位 TOTP 验证码。
- `2fa-verify.html` 已改为调用 `/api/token/verify`，不再保留 `mockDatabase`、`OTPAuth` 或浏览器端 TOTP 生成逻辑。
- 公开页确认 Token 后立即展示当前验证码；首码按服务端 `expiresAt` 倒计时，失效后自动刷新一次第二码，第二码结束后沿用现有失效锁定界面。

## 技术栈

- 前端：静态 HTML、Tailwind CDN、Font Awesome CDN
- 后端：Cloudflare Pages Functions
- 数据库：Cloudflare D1
- 本地开发与部署：Wrangler
- 加密：Workers Runtime Web Crypto API，AES-GCM
- TOTP：HMAC-SHA1，30 秒周期，6 位验证码

## 目录结构

```text
.
├── 2fa-verify.html               # 公开 2FA 查询页
├── admin.html                    # 管理端登录页
├── admin-console.html            # Token 管理台
├── docs/
│   └── token-cloudflare-spec.md  # 项目规格与阶段任务说明
├── functions/
│   └── api/
│       ├── admin/
│       │   ├── export-unused-tokens.js # 管理员未使用 token Excel 导出接口
│       │   ├── generate-tokens.js # 管理员手动生成 token 接口
│       │   ├── import-csv.js     # 管理员 CSV 导入接口
│       │   └── tokens.js         # 管理员 token 列表接口
│       └── token/
│           └── verify.js         # 公开 token 校验接口
├── migrations/
│   └── 0001_init_tokens.sql      # D1 数据库初始化迁移
├── package.json
└── wrangler.toml
```

## 环境要求

- Node.js
- npm
- Cloudflare 账号
- Wrangler CLI，本项目已作为开发依赖安装

安装依赖：

```powershell
npm install
```

## 本地配置

本地开发需要在项目根目录创建 `.dev.vars`，用于注入 Wrangler Pages dev 所需的 secrets。

```text
ADMIN_PASSWORD_HASH=<管理员密码的 SHA-256 十六进制摘要>
TOTP_ENCRYPTION_KEY=<32 字节随机密钥的 base64 字符串>
```

生成管理员密码 hash：

```powershell
$password = "your-admin-password"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($password)
$hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
[Convert]::ToHexString($hash).ToLower()
```

生成 `TOTP_ENCRYPTION_KEY`：

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

不要把 `.dev.vars`、真实管理员密码、真实 TOTP secret 或生产密钥提交到版本控制。

## 数据库

`wrangler.toml` 中的 D1 binding 名称固定为 `DB`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "2fa-token-db"
database_id = "replace-with-cloudflare-d1-database-id"
preview_database_id = "2fa-token-db-local"
```

本地应用 migration：

```powershell
npx wrangler d1 migrations apply 2fa-token-db --local
```

远程应用 migration：

```powershell
npx wrangler d1 migrations apply 2fa-token-db --remote
```

如果是第一次创建远程 D1 数据库：

```powershell
npx wrangler d1 create 2fa-token-db
```

创建后把 Cloudflare 返回的 `database_id` 写入 `wrangler.toml`。

## 本地运行

```powershell
npm run dev
```

默认会通过 Wrangler 启动 Cloudflare Pages 本地开发服务（`dev` 分支默认端口设为 `8789`，调试端口为 `9230`，避免与 `main` 分支的默认 `8788` 冲突）。启动后可访问：

- `http://127.0.0.1:8789/admin.html`：管理端登录页
- `http://127.0.0.1:8789/admin-console.html`：Token 管理台
- `http://127.0.0.1:8789/2fa-verify`：公开 2FA 查询页
- `/api/admin/import-csv`：CSV 导入接口
- `/api/admin/generate-tokens`：手动生成 token 接口
- `/api/admin/export-unused-tokens`：导出未使用 token Excel 接口
- `/api/admin/tokens`：Token 列表接口
- `/api/token/verify`：公开 token 校验接口

## Token 规范

后端自动生成的 token 必须使用固定格式：

```text
TK-XXXX-XXXX-XXXX-XXXX
```

规范说明：

- 前缀固定为 `TK-`。
- 后面 4 组字符，每组 4 位，组之间使用连字符。
- 字符集固定为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。
- 不使用容易混淆的 `I`、`O`、`0`、`1`。
- 示例：`TK-A7KD-9M2Q-X4ZT-P8CN`。

CSV 中显式填写的历史 token 仍会按当前兼容规则校验；所有由系统自动生成的新 token 必须符合以上规范。

## CSV 导入格式

CSV header 至少需要包含 `account_id`、`account_password` 和 `totp_secret`。`token_code` 和 `status` 可选。

```csv
token_code,account_id,account_password,totp_secret,status
TK-A7KD-9M2Q-X4ZT-P8CN,user001,DemoPass2026!,JBSWY3DPEHPK3PXP,active
,user002,DemoPass2026!,JBSWY3DPEHPK3PXP,active
```

字段说明：

- `token_code`：可选。为空时服务端会自动生成类似 `TK-A7KD-9M2Q-X4ZT-P8CN` 的 token。
- `account_id`：必填，账号标识。
- `account_password`：必填，账号登录密码。写入数据库前会加密，管理列表和导出接口不会返回该字段。
- `totp_secret`：必填，Base32 格式的 TOTP secret。
- `status`：可选，支持 `active` 或 `disabled`，默认 `active`。

导入规则：

- CSV 会先整体校验，存在任意行错误时不写入数据库。
- 同一 CSV 中重复 token 会被拒绝。
- 数据库中已存在的 token 会被拒绝。
- API 响应不会返回明文 secret 或加密后的 secret。

## 管理端手动生成

管理端支持输入管理员密码、账号 ID、账号密码、Base32 2FA 密钥、生成数量和状态，批量生成 token。生成数量限制为 `1-100`。

生成出的 token 会立即写入 D1，并可在公开页使用。响应和管理列表都不会返回明文 secret。

## API

### POST `/api/token/verify`

公开 token 校验接口。

请求：

```json
{
  "tokenCode": "TK-A7KD-9M2Q-X4ZT-P8CN"
}
```

成功响应：

```json
{
  "ok": true,
  "code": "123456",
  "accountId": "user001",
  "timeLeft": 28,
  "expiresAt": 1780000000000,
  "nextCode": "654321",
  "nextExpiresAt": 1780000030000
}
```

常见错误：

- `BAD_REQUEST`
- `TOKEN_NOT_FOUND`
- `TOKEN_DISABLED`
- `SECRET_INVALID`
- `SERVER_ERROR`

公开页展示规则：首个验证码不会等待下一个 00 秒或 30 秒边界，而是立即展示当前标准 TOTP。首码的剩余时间可能小于 30 秒，这是它真实有效期的剩余部分；接口会在消费一次性 Token 时预计算下一个时间片，首码到期后页面自动切换并展示一次第二码。第二个验证码展示完整时间片后结束显示，不会继续刷新第三个验证码。

### POST `/api/admin/import-csv`

管理员 CSV 导入接口。

请求：

```json
{
  "adminPassword": "your-admin-password",
  "csv": "token_code,account_id,account_password,totp_secret,status\nTK-A7KD-9M2Q-X4ZT-P8CN,user001,DemoPass2026!,JBSWY3DPEHPK3PXP,active"
}
```

成功响应：

```json
{
  "ok": true,
  "imported": 1,
  "generated": 0,
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

CSV 校验失败时会返回行级错误：

```json
{
  "ok": false,
  "error": "CSV_VALIDATION_FAILED",
  "message": "CSV 校验失败",
  "details": [
    {
      "row": 3,
      "field": "totp_secret",
      "message": "Base32 密钥格式错误"
    }
  ]
}
```

### POST `/api/admin/generate-tokens`

管理员手动生成 token 接口。

请求：

```json
{
  "adminPassword": "your-admin-password",
  "accountId": "user001",
  "accountPassword": "DemoPass2026!",
  "totpSecret": "JBSWY3DPEHPK3PXP",
  "count": 10,
  "status": "active"
}
```

成功响应：

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

### GET `/api/admin/tokens?adminPassword=...`

管理员 token 元数据列表接口。

成功响应：

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

### GET `/api/admin/export-unused-tokens?adminPassword=...`

管理员导出未使用 token Excel 接口。验证码成功发放后 token 会被标记为 `status = used`，因此“未使用 token”定义为 `status = active` 的 token。

接口返回 `.xlsx` 文件。管理台点击导出后会弹出结果框，显示下载地址；点击该地址会进入这个导出接口并下载文件。

Excel 包含列：

```text
account_id, token_code, status, created_at
```

## 部署

设置 Cloudflare Pages secrets：

```powershell
npx wrangler pages secret put ADMIN_PASSWORD_HASH
npx wrangler pages secret put TOTP_ENCRYPTION_KEY
```

部署到 Cloudflare Pages：

```powershell
npx wrangler pages deploy .
```

部署前检查：

- `wrangler.toml` 中 `database_id` 已替换为真实 D1 数据库 ID。
- 远程 D1 migration 已执行。
- Pages secrets 已设置。
- 公开页面已按需要接入 `/api/token/verify`，避免在浏览器端暴露真实 secret。

## 安全约定

- 不在 HTML、JavaScript、文档或配置文件中写入真实 TOTP secret。
- 不向浏览器返回明文 secret、加密 secret 或加密元数据。
- 不明文存储管理员密码，只保存 SHA-256 hash。
- 所有 API 响应设置 `cache-control: no-store`。
- 所有 D1 查询使用 prepared statements。
- 生产环境应使用稳定保存的 `TOTP_ENCRYPTION_KEY`，更换密钥会导致旧数据无法解密。

## 后续待办

- 补充端到端验证：管理员导入 CSV -> 用户输入 token -> 服务端返回验证码。
- 可选：增加独立的 `used_at` 字段，记录 token 首次成功发放验证码的具体时间。
- 可选：把管理员密码 query 参数模式升级为更安全的登录/session 流程。
