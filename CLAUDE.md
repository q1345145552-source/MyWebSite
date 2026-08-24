# 湘泰物流系统 — AI 编码规范与教训

> 以下是我在这个项目中犯过的所有错误，每次改动前必须回顾。

---

## 2026-07-02 ~ 07-03 会话改动总览

### 新增功能
- **整柜询价**：客户端+员工端表单（品名/货值/货重/地址/柜型/清提派/认证文件/产品图片），三端侧边栏入口，DB 新增 `fcl_inquiries` 表
- **侧边栏折叠分组**：三端菜单从平铺改为可折叠展开的分组结构（运单管理/尾端运营/财务等）
- **API 健康检查**：`GET /` 返回 `{"status":"ok"}`，修复部署脚本假警告

### Bug 修复
| 问题 | 修复 |
|---|---|
| 客户端看不到多产品国内单号 | API 返回产品行 domesticTrackingNo，前端聚合展示+搜索 |
| 员工端比管理员端少 104 条运单 | `/staff/shipments` 加 `parentTrackingNo: null` + `take: 500` |
| 员工端+管理员端表头列错位 | `<th>` 和 `<td>` 逐列对齐 |
| Excel 导出中英混杂 | `重量kg→重量`、`体积m3→体积` |
| 部署脚本 API 假警告 | 轮询等待替代固定 `sleep 5` |
| 产品 API 重复查询 | 移除冗余 `include: products` |

### 代码重构
- staff/page.tsx: 3632→2822行(-22%)，提取 6 个组件 + 共享 types/utils
- admin/page.tsx: 2707→2553行(-6%)，提取 ShippingConfig 组件
- client/page.tsx: 复用 staff/utils 工具函数
- menu-config.ts: 新增分组结构 `roleFunctionGroups`
- CI: `.github/workflows/ci.yml`
- 日志: main.ts + server.ts 改用结构化 logger

### 新增文件
```
apps/web/src/modules/staff/types.ts, utils.ts
apps/web/src/components/staff/{StaffProductImagesPanel,ShipmentEditFormField,StaffPrealertList,StaffLastmile}.tsx
apps/web/src/components/admin/ShippingConfig.tsx
apps/web/src/components/client/FclInquiryPanel.tsx
apps/api/src/modules/fcl-inquiries/routes.ts
.github/workflows/ci.yml
```

### 部署
- `deploy.sh` 改为同时构建 web + api，轮询等待最多 60s
- 服务器：`docker exec mywebsite-api-1 npx prisma db execute ...` 建 fcl_inquiries 表

---

## 改代码前强制检查

## 改代码前强制检查

### 1. 删/改任何变量、函数、常量前
```bash
grep -rn "变量名" apps/ --include="*.ts" --include="*.tsx"
```
确认所有引用点，逐一检查是否受影响。

### 2. 写了新函数调用前
确认 import 是否已添加。`grep "新函数名" 当前文件` 看引用次数，如果只有调用没有导入 → 漏了。

### 3. 写 Prisma 查询时
- **Order 表没有 `trackingNo` 字段**，trackingNo 在 Shipment 表。需要通过 `shipments: { take: 1, select: { trackingNo: true } }` 关联查
- 任何 `select: { trackingNo: true }` 都要确认当前 model 是否真的有这个字段

### 4. 改 API 响应结构时
前端 `parseApiResponse` 返回的是 `data` 字段，不是整个响应。后端 `ok(res, { ... })` 会被包成 `{ code: "OK", data: { ... } }`。
前端用 `data.message` 是错的，正确是 `data.data.message`。

### 5. 改 next.config.ts 的 rewrite 规则时
- `/client/:path*` 不能随便拆，因为客户端页面路由和 API 路由混在一起
- 改完必须确保所有 `/client/*` API 请求能正常通过
- 同时检查 `/admin/` 和 `/staff/` 的 rewrite 是否受影响

### 6. 改 Dockerfile 或构建流程时
- 先在本地跑一遍确认能通过
- 特别是 `tsc --noEmit` 需要 `@types/node`

### 7. 改事务相关代码时
- `$transaction(async (tx) => { ... })` 的回调必须 `return` 数据，否则外层拿到的值是 `undefined`
- 事务内所有 Prisma 操作都要用 `tx.xxx` 而不是 `prisma.xxx`
- 事务回调内的 `throw new Error` 不会自动转成 API 错误响应，需要外层 try/catch

### 8. 给某个 model 加了新字段或新关联表后
**必须检查三端（admin/staff/client）的 API 和前端是否都同步了。**
- 三端 API 是独立写的，没有共用数据层，加字段容易漏端
- 典型场景：给 `order_products` 加了字段，员工端/管理员端 API 升级了 `include` 查询，但客户端 API 没改
- 检查方法：`grep -rn "新字段名" apps/api/src/modules/ --include="*.ts"` 看是否三个角色的路由文件都有引用
- 特别注意：客户端有多个 API 端点（`/client/orders`、`/client/shipments/search`、`/client/prealerts`），要逐个检查

### 8b. 三端列表查询条件必须一致
**admin/staff/client 三个端的运单列表 API 的 `where` 条件和 `take` 默认值必须对齐。**
- `parentTrackingNo: null` —— 三个端都应该过滤掉子运单
- `take` 默认值至少 500 —— staff 曾经只有 100，子运单混入后父运单被挤出
- 检查方法：分别读 `/admin/orders`、`/staff/shipments`、`/client/shipments/search` 的 Prisma 查询，对比 `where` 和 `take`

### 8c. 改 API 接口行为前必须 grep 全局调用方
**修改 API 的过滤条件、返回字段、默认值等行为前，必须先列出所有消费端。**
```bash
grep -rn "接口路径" apps/ --include="*.ts" --include="*.tsx"
```
逐项评估每个调用方是否受影响。典型翻车：给 `/staff/shipments` 加 `parentTrackingNo: null` 修了运单列表，但尾端派送的 `loadLmShipments` 也在调同一个接口，子运单被过滤后分柜派送全挂。

### 9. 改动完成后必须收尾清理（最容易漏）
改完代码后，回到每个被修改的文件做三件事：

1. **清理冗余 import**：提取了组件/函数后，原文件里对应的 import 是否还在但不再使用？`grep "import的名字" 当前文件` 确认引用次数 > 1（定义 + 至少一次使用）
2. **清理死代码**：加了新的替代方案（如 `roleFunctionGroups` 替代 `roleFunctionMenus`），旧的删了没？
3. **检查重复逻辑**：新加的代码和已有的代码有没有做同一件事？比如 PR 查询已经 `include` 了，后面又调了一次 `loadXxx()` 函数重复查

**验证命令：**
```bash
npm run build  # 能过不代表没冗余，但过不了说明有问题
grep -rn "被提取的函数名" apps/web/src/app/ --include="*.tsx"  # 看原文件里还有没有残留定义
```

## 曾经犯过的具体错误

| # | 错误 | 教训 |
|---|---|---|
| 1 | 删了常量但下游还在引用 | 删之前 grep 全局 |
| 2 | Prisma select 写了不存在的字段 | 查 schema 确认字段存在 |
| 3 | 所有图片 base64 塞进响应 | 大数据量字段不要随列表返回 |
| 4 | 加了函数调用忘了 import | 写完检查 import 区 |
| 5 | 改 rewrite 规则导致请求匹配不上 | 改配置全链路测试 |
| 6 | 事务回调没 return 导致变量引用崩溃 | 事务回调最后 return 数据 |
| 7 | 改构建流程没本地先跑 | 构建改动先验证 |
| 8 | 加了 `order_products` 表和多产品功能，只改了 staff/admin 的 API 和前端，客户端 API 没同步升级，导致客户端看不到产品行级别的国内单号 | 给 model 加字段/加关联表后，三端 API + 前端逐个检查 |
| 9 | 组件提取后遗留了未使用的 import（PrealertSearch、calcOrderAmountCny 等）、死代码没删（roleFunctionMenus）、API 重复查询（include + loadOrderProducts 双查） | 改动完成后回到每个被改文件做收尾清理：冗余 import、死代码、重复逻辑 |
| 10 | 改表头列顺序（到仓日期从第4列挪到第3列），只改了 `<th>` 没同步改 `<td>` 数据行，导致列错位——唛头下面是品名、品名下面是箱数…… | 改表格列顺序时，`<th>` 和 `<td>` 必须一起改，改完逐列对照表头和数据确认对齐 |
| 11 | 员工端 `/staff/shipments` 不过滤 `parentTrackingNo: null`，子运单混入列表占满前 100 条，导致部分父运单被挤出、员工看不到 | 三端列表查询条件必须对齐：都用 `parentTrackingNo: null` 过滤子运单，`take` 默认值至少 500 |
| 12 | 给 `/staff/shipments` 加了 `parentTrackingNo: null` 过滤，只检查了运单列表调用方，没发现尾端派送也在用同一个接口——尾端派送正需要子运单，导致分柜后看不到子运单 | **改 API 接口行为前，必须 grep 全局所有调用方**：`grep -rn "接口路径" apps/` 列出所有消费端，逐个评估影响 |
| 13 | 派送单号用 `count()` 生成——删过的单号会被重新分配，触发唯一约束报 Internal Server Error | **生成自增编号用 max 不用 count**：`findFirst(orderBy: {xxx: "desc"})` 取最大值 +1，不受删除影响 |
| 14 | 分柜功能是后来加的，但运单列表/装柜/尾端派送/编辑查重等模块各自处理父运单和子运单的逻辑不一致——有的看父、有的看子、有的该看子却看了父 | **加了子运单概念后，必须逐个模块梳理「该看父还是该看子」**：运单列表=父，装柜=子，尾端派送=子，编辑查重=排除自己的那个 |
| 15 | API 加了分页后默认 `pageSize=50`，前端三个调用方（fetchStaffShipments/fetchAdminOrders/fetchClientOrders）都没有传 `pageSize` 参数，结果只拿到 50 条，用户以为数据丢了 | **改 API 默认值时，必须搜全局调用方确认是否传了新参数**：不改默认值而是让前端显式传，或者在 API 层保留老默认值兼容 |
| 16 | 尾端派送的 `loadLmShipments` 传 `limit=500`，但 API 参数名是 `pageSize`，`limit` 被忽略 → 只加载 50 条运单，唛头不全 | **前端调 API 参数名必须和 API 源码一致**：前后端参数名不匹配不会编译报错，只能靠人工核对 |
| 17 | 编辑运单保存时 API 先判断 `trackingNo !== shipment.trackingNo` 再查重，但两端值可能因空格/编码差异被判为不等 → 误报 "trackingNo already exists" | **查重不要依赖前置相等判断**：直接查重 + 始终排除自身 ID，避免不可见字符差异导致误判 |
| 18 | 尾端派送唛头列 `minWidth: 70` + 无 `nowrap`，长 clientId 被换行截断 | **ID/编号类字段至少 100px + `whiteSpace: "nowrap"`**，防止静默截断数据 |
| 19 | 尾端派送丢货：页面拿「按更新时间排的前 500 条运单（所有状态混在一起）」回来**自己在前端筛**能派送的三种状态。生产 1026 张运单里能派送的有 571 张，但排进前 500 的只有 126 张——**445 张、5791 件货页面上根本选不到**；粘贴运单号批量勾选时这些号码被**静默丢弃**，员工以为加进去了 | **筛选必须放在后端 `where` 里，不能拉一页回来在前端筛**：前端筛只对「已经全拿到」的数据成立。凡是列表要「拿全」，就得按 `total` 翻页拿完。**批量匹配找不到的项必须显式列出来**，绝不能静默跳过 |
| 20 | 上一条修完后只改了员工端的 `StaffLastmile.tsx`，**管理员端 `admin/page.tsx` 里另有一套独立的尾端派送界面没动**——它还写死只显示 20 条，而且运单列表只在搜索框 `onFocus` 时才加载，不点就一直空白。用户打开管理员端发现「没数据」 | **尾端派送在管理员端和员工端是两套各写各的界面**（admin/page.tsx 内联 vs components/staff/StaffLastmile.tsx），改一个必须同时改另一个。更一般地：修 UI 缺陷前先 `grep -rn "功能关键词" apps/web/src/app/{admin,staff,client}` 确认这个功能到底有几套实现 |
| 21 | 列表写死 `.slice(0, N)` 截断且不显示总数 —— 唛头砍到 10 个（实有 42 个）、可选运单砍到 50/20 条 | **列表不要静默截断**。要么全渲染（容器自己滚），要么截断的同时写清楚「共 N 条 / 只显示前 M 条」。判断标准：看不到的数据用户有没有办法知道它存在 |
| 22 | 集货余额改造时后端 `/client/wallet/overview` 不再返回 `exchangeRate`，但前端 `ClientWalletOverview` 里还声明着它，`client/page.tsx` 照旧读 `.exchangeRate.rate` → **客户一打开首页就白屏报「Cannot read properties of undefined (reading 'rate')」**。而 tsc 全绿、构建成功、服务器 0 报错、页面照返回 200，**所有自动检查全部放行**，直到用户自己发现 | **前端的接口类型是手写的，TypeScript 不会去核对后端**。改后端 `ok(res, {...})` 的返回结构后，必须 `grep -rn "接口路径" apps/web/src/services/` 找到对应的 interface 同步改掉。<br>**更要紧的是验证方式**：接口通不通、有没有 500、页面返不返回 200，**这三样都照不到前端崩溃** —— 前端报错只在浏览器控制台里。改完前端必须真的打开页面看控制台，三端都要看 |
| 23 | 批量把写死颜色换成 CSS 变量时，脚本把 **canvas 的 `ctx.fillStyle = "#ffffff"` 也换成了 `var(--white)`**。canvas 是 JS 接口不是 CSS，浏览器认不出就退回默认的**黑色** —— 带透明背景的 PNG 压缩后会变成黑底。同一批还把**打印标签**（`document.write` 到新窗口）里的 `#000` 换成了 `var(--t-strong)`，那个窗口根本没有 globals.css，变量解析不出来。tsc 全绿、构建通过、E2E 也过（因为测试图都是不透明的 JPEG，黑底被图盖住了），**部署前逐行复查才发现** | **`var(--xxx)` 只在「主文档的 CSS」里有效**。批量替换颜色前先把这几类排除掉：<br>① canvas 的 `fillStyle` / `strokeStyle` / `shadowColor`（JS 接口）<br>② `document.write` / `innerHTML` 写进**新窗口**的 HTML（那边没有 `:root` 变量）<br>③ 图表库的 `stroke=` / `fill=` 属性和数据对象<br>④ Excel/PDF 导出的颜色<br>**验证要用会暴露问题的数据**：测透明背景就得用**透明 PNG**，拿不透明 JPEG 测等于没测 |
| 24 | **一天之内连报三个假问题给用户，全是「读代码推结论、没在页面上看过」**：<br>① 报「540 张运单客户看不到物流轨迹」→ 实际 **1 张**，还是测试单。轨迹写在**子单**上，轨迹弹窗会把父单+子单**合并**显示，我只查了父单自己有没有记录<br>② 报「21 张已装柜但轨迹停在已创建」「4 张状态和轨迹对不上」→ 合并子单后**全部一致，0 个问题**。同一个错误当天犯第二次<br>③ 报「运单列表显示 188 件（父单68+子单120）」→ 列表那一列显示的是**订单产品行的箱数**（30+50+20+20=120），我改的那个字段**在那一页根本不出现**。用户当场指出「我在系统看到就是 120 件」 | **报任何数字/现象之前，先在页面上看到它。看不到就说「我没验证过」。**<br>① **按用户实际看到的口径查，不是按单表查**。运单尤其：客户点开的是父单，但看到的是**父单 + 全部子单合并**的结果（`/client/shipments/track` 里 `childShipments` 那段）。只查父单必然误报<br>② **代码里算了一个值 ≠ 页面上显示这个值**。`grep` 到后端算了 `totalPackageCount`，还必须再 `grep` 前端有没有用它、用在哪一页 —— 实测它只用在装柜页，运单列表压根没用<br>③ **「功能坏没坏」要真去点那个按钮。** 撤销柜子状态在生产上 102/106 都是坏的，`tsc` 0 错、构建通过、页面 200、控制台干净——四样全过，因为从来没人点过那个按钮<br>④ **只在测试库点等于没点。** 测试库的柜子是自己一步步造的，记录整整齐齐；生产上带着历史包袱（老数据缺字段、字段是后加的），要拿生产数据**只读**跑一遍才照得出来 |
| 25 | **2026-08-14 又报了两个「根本不存在」的问题，外加一次没查全就下结论**：<br>① 报「客户首页那条 8 格进度条不认识新状态、会掉回第一格」，还动手「修」了它 —— 那套进度条（`ORDER_TIMELINE` / `buildOrderTimeline` / `normalizeTimelineStatus`）**三者互相调用，但没有任何 JSX 用到，从来没被渲染过**。等于修死代码，白改<br>② 报「客户会看到两条一样的『已装柜』」→ 是我自己的分析脚本把 `data.timeline` 和 `data.children[].timeline` **相加**了，而后端给父单的那份 `timeline` **本来就已经合并了子单记录**，轨迹弹窗又是**分页签**、一次只渲染一个 —— 每条被算了两遍<br>③ 说「仓库版集货金额是自动算的」时，我**只看到有个 `calcFeeFromItems` 函数存在**，没确认它真的被调用、结果真的写进 `totalFee`。用户追问才去把调用链追全（结论侥幸对了）。他原话：**「你肯定要查准才能回答我啊，不然你会误导我」** | **① 「代码里有」≠「页面上有」。** 报任何 UI 现象前，先确认那段代码**真的被渲染**：`grep` 那个组件/常量的引用次数，只有定义没有使用 = 死代码。最稳的是在浏览器里搜那几个字。<br>**② 自己写的分析脚本会骗自己。** 脚本里别自己抄状态名单、别自己再实现一遍合并/排序逻辑 —— 要么直接 import 真代码，要么用正则从真源码里读，要么看接口真实返回值。尤其 `/client/shipments/track`：**父单的 `timeline` 已含子单记录，再加一次就是双份**。<br>**③ 追到底再开口。** 看到一个函数存在不算数，要确认「谁调用它、结果用在哪、页面/接口最终拿到的是不是它」。查不到就直说「我没查」，别用「应该是」糊。 |
