# 中泰国际物流系统（V1）

单仓库、单前端应用（RBAC），包含三个角色界面：

- `admin`（管理员）
- `staff`（员工）
- `client`（客户端）

并已接入 DeepSeek AI 对话能力（客户端提问订单进度/发货汇总）。

## 目录结构

- `apps/web`：前端（Next.js）
- `apps/api`：后端（最小 HTTP 服务）
- `packages/shared-types`：共享类型
- `docs`：业务与协作文档

## 运行要求

- Node.js 20+
- npm

## 启动方式

### 1) 启动后端（端口 3001）

```bash
cd "/Users/liuxiong/Desktop/物流网站制作/MyWebSite"
export DEEPSEEK_API_KEY="sk-你的真实key"
export DEEPSEEK_MODEL="deepseek-chat"
export DEEPSEEK_API_BASE_URL="https://api.deepseek.com/chat/completions"
npx tsx apps/api/src/main.ts
```

### 2) 启动前端（端口 3000）

```bash
cd "/Users/liuxiong/Desktop/物流网站制作/MyWebSite/apps/web"
npm install
npm run dev
```

访问：

- `http://127.0.0.1:3000/`

## 模拟登录（开发模式）

首页提供“模拟登录用户”面板，可选择角色并进入对应页面：

- `client` -> `/client`
- `staff` -> `/staff`
- `admin` -> `/admin`

请求头会自动附带：

- `x-role`
- `x-user-id`
- `x-company-id`

## AI 功能

客户端：

- AI 客服按钮（对话）
- 常用问题建议

管理员：

- 状态中文映射管理（保存/恢复默认）
- AI 知识投喂（新增）
- AI 知识删除
- AI 审计日志查询（接口）

## 核心接口（V1）

- `POST /client/ai/chat`
- `GET /client/ai/suggestions`
- `GET /admin/ai/audit-logs`
- `GET /admin/system/status-labels`
- `POST /admin/system/status-labels`
- `POST /admin/system/status-labels/reset`
- `GET /admin/ai/knowledge`
- `POST /admin/ai/knowledge`
- `DELETE /admin/ai/knowledge?id=kn_xxx`

## 常见问题

### 1) 3001 端口被占用

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs -r kill -9
```

### 2) AI 返回“未配置 API Key”

说明后端未读到 `DEEPSEEK_API_KEY`。请在项目根目录建 `.env` 并写 `DEEPSEEK_API_KEY=sk-xxx`，或在同一终端 `export DEEPSEEK_API_KEY="sk-xxx"` 后再启动后端。详见 [docs/deepseek-setup.md](docs/deepseek-setup.md)。

### 3) AI 返回 402

说明 DeepSeek 账户额度或计费配置问题，不是本地代码链路问题。
