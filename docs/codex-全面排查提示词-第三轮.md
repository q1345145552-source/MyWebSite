你是一名资深工程师。请对这个仓库做一次**只读**全面排查。

# ⛔ 绝对禁止

- **不要修改任何文件**（包括格式化、lint 自动修复）
- **不要写数据库**（生产、测试库都不行）
- **不要执行构建、迁移、部署、重启服务**
- 生产 SQL 一律用 `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='8s'; ... ROLLBACK;`
- 排查结束时 `git status --short` 必须和开始时完全一致

# 系统背景

中泰跨境物流系统。后端 `apps/api`（Node + TypeScript + Prisma + PostgreSQL），
前端 `apps/web`（Next.js，admin/staff/client 三端），共享类型 `packages/shared-types`。
生产：单台服务器 + Docker Compose，`deploy.sh` 部署。生产库只有一家公司 `c_001`。

**先读**：`CLAUDE.md`（25 条历史教训）、`docs/交接文档-2026-08-21-完整版.md`。

# 本轮要重点复查的改动（全部未提交、未上线）

```
apps/api/src/modules/shipments/parent-status.ts   （新文件）
apps/api/src/modules/loading-manifests/routes.ts
apps/api/src/modules/containers/routes.ts
apps/api/src/modules/admin-ops/routes.ts
apps/api/src/modules/admin/routes.ts
apps/api/src/modules/ai/ai-service.ts
apps/web/src/app/admin/page.tsx
apps/web/src/services/business-api.ts
packages/shared-types/shipment-status.ts
deploy.sh
```

## ⚠️ 我自己没能验证的三处，请优先查

1. **父单状态函数的 6 个接入点，只有「分柜」那一处做过端到端验证。**
   另外 5 处（尾端派送创建/签收/删除、柜子推进、撤销柜子状态）只做了代码检查。
   请核对每一处的调用时机、事务边界、以及父单件数>0 时的跳过逻辑是否合理。

2. **AI 模块的在途状态清单换成了共享常量，完全没做运行验证。**
   `ai-service.ts` 原来自己写了一份清单（漏掉 5 个陆运状态），现在改用
   `packages/shared-types/shipment-status.ts` 里推导出来的 `IN_TRANSIT_STATUSES`。
   请确认：AI 的其它 statusScope 分支（completed/unfinished/exception）是否仍然自洽、
   有没有别处依赖旧清单的长度或顺序。

3. **`deploy.sh` 调整了执行顺序**（备份 → 迁移 → 切容器 → 连库健康检查），
   没有完整跑过。请逐行审查：
   - `docker compose run --rm -T api` 起一次性容器跑迁移，会不会和正在服务的旧容器抢端口/卷/网络
   - 迁移失败、备份失败时的分支是否都能安全退出
   - 新加的「连库健康检查」用 `migrate status` 判断是否合适
   - 脚本自我复制到 /tmp 的保护机制在改动后是否仍然成立

# 已知且已确认的，不用重复报告

- 集货货型/删货物功能（已上线）
- 运营看板 8 处数字错误（已修）
- 尾端派送列表返回 113MB base64（已修）
- 分柜体积重量算重（已修，生产 3 张旧语义数据已修正）
- 卸柜不恢复体积重量（已修并验证）
- 父单状态被单个子单覆盖（已修，生产 11 张历史数据**尚未**修正）
- 钱包并发扣款（已知，未修）
- 令牌封禁后不失效（已知，未修）
- 同一运单进多张派送单（已知，未修）
- 92MB 重复产品图（已知，未处理）

**用户已拍板不改**：`staffCanEditOrderWarehouse()` 永远返回 true（「不分仓库管」）；
数据库端口绑定 0.0.0.0（iptables 已实测挡住）。

# 这个系统特有的坑

- **物流轨迹写在子单上**，只查父单必然误报
- **柜货关系在 `shipment_container_items`**，不是 `shipments.batch_no`（后者 1852 张单只有 38 张填了）
- **后端容器跑在 UTC**，凡「今天/本月」统计都要注意
- **海运 22 步 / 陆运 16 步两套流程**，不能混用
- 后端 `tsc --noEmit` **基线就有 19 个错误**，只报新增的
- 分柜 bug 类问题**只在第二次及以后分柜才现形**

# 输出格式

按严重程度排序：

```
【严重程度】P0 丢数据/资金错 | P1 功能不可用 | P2 体验或维护
【问题】一句话
【证据】文件:行号，或只读 SQL + 实际输出
【实际影响】结合真实数据；影响不到就写「当前无实际影响」
【修复建议】具体到函数/字段
```

最后必须单列两节：
1. **「本轮改动中复查通过的部分」** —— 明确说哪些我改对了
2. **「我没能验证的部分」** —— 只看代码没实际运行的，逐条列出
