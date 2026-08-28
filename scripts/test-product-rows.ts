/**
 * 产品行校验的自测（不连数据库、不连网络）。
 *
 * 这三条用例是 2026-08-29 复核**真实调接口拦下写库参数**测出来的，
 * 不是我脑补的：
 *   · 每箱 0 个 + 订单级总数 999 → 返回 200，订单存成 999
 *   · 每箱 -3 个                → 返回 200
 *   · 每箱 1.5 个 × 2 箱         → 存成 3
 * 所以这个脚本必须能把这三条抓住，抓不住就说明白写了。
 *
 * ⚠️ 后端（apps/api/.../product-row-guard.ts）和前端
 *   （apps/web/.../productRowGuard.ts）是两份实现、一份口径，
 *   所以两边都要测 —— 只测一边，另一边改坏了没人知道。
 */
/**
 * ⚠️⚠️ **硬闸：这个脚本一次数据库都不许连。**
 *
 * 这一轮我在同一个坑里栽了**三次** —— 写「正常输入不许被误伤」的用例时，
 * 给了一份合法数据，它就一路走到 `prisma.order.create` 真的连上了 Neon 测试库
 * （每次都是靠外键报错才发现）。`test-ai-chat-limits.ts` 开头记着同一条教训。
 *
 * 靠「我记得要避开」是不行的，所以在这里把数据库地址换成一个**根本连不通**的，
 * 一旦有用例不小心走到写库，就会当场炸出来，而不是安安静静地连上去。
 * ⚠️ 必须在 import 任何会创建 PrismaClient 的模块**之前**设。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

import assert from "node:assert/strict";
import {
  validateProductRows as apiValidate,
  validateOrderLevelQuantity,
} from "../apps/api/src/modules/orders/product-row-guard";
import {
  validateProductRows as webValidate,
  packageCountForPayload,
} from "../apps/web/src/modules/orders/productRowGuard";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

console.log("产品行校验");

// ============ 后端 ============

check("后端 1) 复核实测那三条非法「每箱几个」全部拦下", () => {
  // 每箱 0 个 —— 原来会掉进「用订单级总数」的兜底，存成 999
  assert.equal(apiValidate([{ packageCount: 2, productQuantity: 0 }]), "产品行1的「每箱几个」必须是正整数");
  // 每箱 -3 个
  assert.equal(apiValidate([{ packageCount: 2, productQuantity: -3 }]), "产品行1的「每箱几个」必须是正整数");
  // 每箱 1.5 个 × 2 箱 —— 原来存成 3
  assert.equal(apiValidate([{ packageCount: 2, productQuantity: 1.5 }]), "产品行1的「每箱几个」必须是正整数");
});

check("后端 2) 箱数必须是正整数", () => {
  assert.equal(apiValidate([{ packageCount: 0, productQuantity: 5 }]), "产品行1的箱数必须是正整数");
  assert.equal(apiValidate([{ packageCount: -1, productQuantity: 5 }]), "产品行1的箱数必须是正整数");
  assert.equal(apiValidate([{ packageCount: 2.5, productQuantity: 5 }]), "产品行1的箱数必须是正整数");
  assert.equal(apiValidate([{ packageCount: undefined, productQuantity: 5 }]), "产品行1的箱数必须是正整数");
  assert.equal(apiValidate([{ packageCount: "3", productQuantity: 5 }]), "产品行1的箱数必须是正整数");
});

check("后端 3) 出错时报的是第几行 —— 报错行号不对，员工会去改错的那一行", () => {
  // ⚠️ 故意用三行不同的箱数（4/7/9），避免「拿相同的数假绿」
  assert.equal(
    apiValidate([
      { packageCount: 4, productQuantity: 2 },
      { packageCount: 7, productQuantity: 3 },
      { packageCount: 9, productQuantity: 0 },
    ]),
    "产品行3的「每箱几个」必须是正整数",
  );
  assert.equal(
    apiValidate([
      { packageCount: 4, productQuantity: 2 },
      { packageCount: 0, productQuantity: 3 },
      { packageCount: 9, productQuantity: 6 },
    ]),
    "产品行2的箱数必须是正整数",
  );
});

check("后端 4) 「每箱几个」全填或全空；全空要放行", () => {
  assert.equal(
    apiValidate([
      { packageCount: 4, productQuantity: 2 },
      { packageCount: 7 },
    ]),
    "同一张单的「每箱几个」需要全部填写或全部留空",
  );
  // 全空 = 这张单不统计「每箱几个」，合法
  assert.equal(apiValidate([{ packageCount: 4 }, { packageCount: 7 }]), null);
  // 全填且都是正整数，合法
  assert.equal(
    apiValidate([
      { packageCount: 4, productQuantity: 2 },
      { packageCount: 7, productQuantity: 3 },
    ]),
    null,
  );
  // 没有产品行的单子直接放行
  assert.equal(apiValidate([]), null);
});

check("后端 5) 订单级「产品数量」：负数和小数拦下，0 和空放行", () => {
  assert.equal(validateOrderLevelQuantity(-5), "「产品数量」必须是不小于 0 的整数");
  assert.equal(validateOrderLevelQuantity(1.5), "「产品数量」必须是不小于 0 的整数");
  assert.equal(validateOrderLevelQuantity(Number.NaN), "「产品数量」必须是不小于 0 的整数");
  assert.equal(validateOrderLevelQuantity("999"), "「产品数量」必须是不小于 0 的整数");
  assert.equal(validateOrderLevelQuantity(0), null);
  assert.equal(validateOrderLevelQuantity(29), null);
  assert.equal(validateOrderLevelQuantity(undefined), null);
});

// ============ 前端 ============
// 前端收的是表单里的**字符串**，所以用例也要用字符串，
// 拿数字测等于没测到真实输入。

check("前端 1) 箱数留空或填 0 会被拦下 —— 老板最早报的就是这条", () => {
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "", productQuantity: "5" }])?.includes("箱数必须填正整数"));
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "0", productQuantity: "5" }])?.includes("箱数必须填正整数"));
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "abc", productQuantity: "5" }])?.includes("箱数必须填正整数"));
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "2.5", productQuantity: "5" }])?.includes("箱数必须填正整数"));
});

check("前端 2) 「每箱几个」那三条非法值同样拦下", () => {
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "2", productQuantity: "0" }])?.includes("必须填正整数"));
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "2", productQuantity: "-3" }])?.includes("必须填正整数"));
  assert.ok(webValidate([{ itemName: "耳机", packageCount: "2", productQuantity: "1.5" }])?.includes("必须填正整数"));
});

check("前端 3) 正常填写要放行（别把能用的挡了）", () => {
  assert.equal(
    webValidate([
      { itemName: "耳机", packageCount: "2", productQuantity: "2" },
      { itemName: "手机壳", packageCount: "3", productQuantity: "3" },
      { itemName: "充电器", packageCount: "4", productQuantity: "4" },
    ]),
    null,
  );
  // 「每箱几个」全留空也合法
  assert.equal(
    webValidate([
      { itemName: "耳机", packageCount: "2", productQuantity: "" },
      { itemName: "手机壳", packageCount: "3", productQuantity: "" },
    ]),
    null,
  );
});

check("前端 4) packageCountForPayload 绝不能再兜底成 1", () => {
  // 这一条就是防止有人手滑把 `|| 1` 加回去
  assert.ok(Number.isNaN(packageCountForPayload("")), "空箱数必须是 NaN，不能是 1");
  assert.ok(Number.isNaN(packageCountForPayload(undefined)), "没填的箱数必须是 NaN，不能是 1");
  assert.ok(Number.isNaN(packageCountForPayload("abc")), "填了乱码的箱数必须是 NaN，不能是 1");
  assert.equal(packageCountForPayload("0"), 0, "填 0 就要老老实实是 0，不能变成 1");
  assert.equal(packageCountForPayload("7"), 7);
});

check("前端 5) 前后端口径一致 —— 同一份输入两边给同样的结论", () => {
  // 后端收数字、前端收字符串，同一批用例两边的「过 / 不过」必须一样。
  // ⚠️ 用互不相同的数字（3/6/8/11），免得相同的数假绿。
  const cases: Array<[number | null, number | null, boolean]> = [
    [3, 6, true],
    [0, 6, false],
    [3, 0, false],
    [8, -3, false],
    [11, 1.5, false],
    [3, null, true],
  ];
  for (const [pkg, qty, shouldPass] of cases) {
    const apiResult = apiValidate([
      { packageCount: pkg ?? undefined, productQuantity: qty ?? undefined },
    ]);
    const webResult = webValidate([
      { packageCount: pkg === null ? "" : String(pkg), productQuantity: qty === null ? "" : String(qty) },
    ]);
    assert.equal(
      apiResult === null,
      shouldPass,
      `后端对 (箱数=${pkg}, 每箱=${qty}) 的结论不对：${apiResult}`,
    );
    assert.equal(
      webResult === null,
      shouldPass,
      `前端对 (箱数=${pkg}, 每箱=${qty}) 的结论不对：${webResult}`,
    );
  }
});


// ============ 三个入口都要接上（源码检查）============
// ⚠️ 上一轮我只把 /staff/orders 接上了校验，另外两个入口原封不动 ——
// 而 10 项全绿，因为它们测的是**函数本身**，没人问「这个函数有没有被调用」。
// 第七轮复核真调 /client/prealerts 传 packageCount:0，返回 200 存成 1 箱。
// 这一项就是盯着「新写的入口有没有忘了接」。

/**
 * ⚠️ 第 11 项**必须真调路由**，不能扫源码（2026-08-29 改）。
 *
 * 第一版是扫源码找 `validateProductRows(`。做变异把校验包进 `if (false)`，
 * **12 项照样全绿** —— 死代码里的调用照样被扫到。
 * Codex 同一天在锁序扫描器上报的是同一件事（`if (false) await ... FOR UPDATE`）。
 * **扫源码证明不了行为**，只能证明「这几个字出现过」。
 *
 * 做法照 `test-ai-chat-limits.ts` 那套：把路由注册进一个假 app，
 * 直接拿到 handler 调它。校验发生在任何数据库访问之前，所以全程不连库。
 */
type Handler = (req: any, res: any) => Promise<void> | void;

async function loadRoutes(): Promise<Map<string, Handler>> {
  const routes = new Map<string, Handler>();
  const fakeApp = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const orders = await import("../apps/api/src/modules/orders/routes");
  const admin = await import("../apps/api/src/modules/admin/routes");
  const containers = await import("../apps/api/src/modules/containers/routes");
  const adminOps = await import("../apps/api/src/modules/admin-ops/routes");
  (orders as any).registerOrderRoutes(fakeApp);
  (admin as any).registerAdminRoutes(fakeApp);
  (containers as any).registerContainerRoutes(fakeApp);
  (adminOps as any).registerAdminOpsRoutes(fakeApp);
  return routes;
}

/** 调一次路由，返回状态码和提示语。⚠️ 拿到 200 或 500 都说明它穿过校验去连库了 */
async function callRoute(
  handler: Handler,
  auth: { userId: string; companyId: string; role: string; name: string },
  body: unknown,
): Promise<{ status: number; message: string }> {
  let status = 0;
  let payload: { message?: string } = {};
  const res: any = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { payload = value as { message?: string }; },
  };
  await handler({ method: "POST", path: "", query: {}, headers: {}, body, auth }, res);
  return { status, message: payload.message ?? "" };
}

/**
 * ⚠️ **光看状态码 400 是不够的**（2026-08-29 修）。
 *
 * 第一版只断言「拿到 400」。做变异把 `/staff/orders` 的校验包进 `if (false)`，
 * **14 项照样全绿** —— 因为那个请求缺别的必填项，落到下一道闸也是 400。
 * 「拿到 400」证明不了「是被产品行校验拦下的」。
 * 所以必须连**报错内容**一起对：只有出现「箱数 / 每箱几个」才算这道闸生效了。
 */
function assertIsProductRowError(label: string, message: string): void {
  assert.ok(
    /箱数|每箱几个/.test(message),
    `【${label}】是被 400 了，但报错不是产品行校验发的：${JSON.stringify(message)}\n` +
      `     —— 说明它是掉进别的闸才 400 的，产品行这道闸可能根本没生效`,
  );
}

let routeTable: Map<string, Handler>;

async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

check("9) 超过数据库整数上限的要在门口拦下，别到写库才炸", () => {
  /**
   * 第七轮复核报的：前后端都接受 `2147483648` 和 `9007199254740992`，
   * 但数据库那几列是 Prisma `Int`（PostgreSQL 32 位 integer，最大 2147483647）。
   * 这种输入会一路穿到写库那一刻才报错，员工只看到「服务器繁忙」，
   * 根本不知道是自己填的数太大。
   * ⚠️ 边界两头都测：2147483647 要放行，2147483648 要拦。
   */
  assert.equal(apiValidate([{ packageCount: 2147483647, productQuantity: 1 }]), null, "刚好到上限的被误拦了");
  assert.equal(
    apiValidate([{ packageCount: 2147483648, productQuantity: 1 }]),
    "产品行1的箱数必须是正整数",
    "超过 32 位整数上限的箱数没被拦",
  );
  assert.equal(
    apiValidate([{ packageCount: 1, productQuantity: 9007199254740992 }]),
    "产品行1的「每箱几个」必须是正整数",
    "超大的「每箱几个」没被拦",
  );
  assert.ok(
    validateOrderLevelQuantity(2147483648)?.includes("不能超过"),
    "订单级产品数量超上限没被拦",
  );
  assert.equal(validateOrderLevelQuantity(2147483647), null, "刚好到上限的订单级数量被误拦了");

  // 前端同一口径
  assert.ok(
    webValidate([{ itemName: "耳机", packageCount: "2147483648", productQuantity: "1" }]),
    "前端没拦超上限的箱数",
  );
  assert.equal(
    webValidate([{ itemName: "耳机", packageCount: "2147483647", productQuantity: "1" }]),
    null,
    "前端把刚好到上限的误拦了",
  );
});

check("10) 全仓库不许再有「把箱数兜底成 1」的写法", () => {
  /**
   * 上面第 11 项只查那三个入口。这一项扫全部后端和前端 ——
   * 以后新写的入口漏了会立刻被逮住，不用等谁想起来去加白名单。
   */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const roots = [
    path.join(__dirname, "..", "apps", "api", "src"),
    path.join(__dirname, "..", "apps", "web", "src"),
  ];
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//")) return; // 注释里提到不算
        /**
         * ⚠️ 上一版只认两种写法（`packageCount || 1` 和 `Math.max(1, ...packageCount)`），
         * 第八轮复核找出两处它抓不到的：
         *   · `n[i].packageCount = Math.max(1, Number(e.target.value))`
         *     —— packageCount 在**等号左边**，右边根本没有这个词
         *   · `packageCount: Number(r["箱数"] ?? r.packageCount ?? 1)`
         *     —— 用的是 `?? 1` 不是 `|| 1`
         * 现在分两路认：① 这一行提到 packageCount，② 这一行有兜底成 1 的写法。
         * 两个条件同时成立才算 —— 只看①会把正常代码全标红。
         */
        const mentionsPkg = /packageCount/.test(line);
        const hasFallbackToOne =
          /(\|\||\?\?)\s*1\b/.test(line) ||
          /Math\.max\(\s*1\s*,/.test(line) ||
          /Math\.max\([^,]+,\s*1\s*\)/.test(line);
        if (mentionsPkg && hasFallbackToOne) {
          hits.push(`${path.relative(path.join(__dirname, ".."), full)}:${i + 1}  ${t.slice(0, 90)}`);
        }
      });
    }
  };
  for (const r of roots) walk(r);
  /**
   * 白名单。⚠️ 往里加东西之前必须**先去读那一行**，确认它真的走不到 ——
   * 这张表越长，这一项越没用。每一条都要写清「为什么它是安全的」。
   */
  const allowed = [
    // 打印标签：显示「第 N 件 / 共 M 件」用的，不进数据库、不参与任何合计
    "modules/shipment/ShipmentPrintLabel.tsx",
    /**
     * 仓库版集货：**上游已经卡死了**。同文件 ~256 行有
     *   `if (!Number.isFinite(pkg) || pkg <= 0) → 400「第 N 行件数必须大于 0」`
     * 也就是说走到 310 / 351 行时 packageCount 一定 > 0，那两个 `|| 1` 是死代码。
     * （2026-08-29 逐行读过确认。这条路的方数要拿去按「方数 × 单价」收费，
     *   真有兜底会直接算错钱，所以特意核了两遍。）
     */
    "whr-consolidation/client-routes.ts",
    /**
     * 仓库版集货的**前端估算**：只用来在页面上实时显示预估方数/重量，
     * 不发给后端、不进数据库；后端收到后按自己那套重算并校验。
     */
    "client/whr-consolidation/page.tsx",
    /**
     * 拆柜派送清单导出：`const packageTotal = ...reduce(...) || 1` ——
     * 这个 `|| 1` 是**除零保护**，不是猜箱数：下一行拿它当分母
     *   `Number(product.packageCount || 0) / packageTotal`
     * 合计为 0 时分子也一定是 0，share 仍然是 0，结果不受影响；
     * 不兜底反而会算出 NaN 印到客户签收单上。
     * （2026-08-29 逐行读过确认。）
     */
    "lastmile/exportDispatchWorkbooks.ts",
  ];
  const bad = hits.filter((h) => !allowed.some((a) => h.includes(a)));
  assert.deepEqual(bad, [], "下面这些地方还在把箱数兜底成 1：\n     " + bad.join("\n     "));
});

async function main(): Promise<void> {
  routeTable = await loadRoutes();

  const CLIENT = { userId: "u_test_client", companyId: "c_test", role: "client", name: "测试客户" };
  const STAFF = { userId: "u_test_staff", companyId: "c_test", role: "staff", name: "测试员工" };
  const ADMIN = { userId: "u_test_admin", companyId: "c_test", role: "admin", name: "测试管理员" };

  /**
   * ⚠️ 三个入口都用**同一组非法输入**打一遍。
   * 拿到 400 = 校验拦住了（而且是在连库之前）；
   * 拿到 200 或 500 = 它穿过去了 —— 这正是第七轮复核在客户建单上实测到的
   * （传 packageCount: 0 → 200，三处全存成 1）。
   */
  const BAD_ROWS = [
    { label: "箱数 0", row: { itemName: "耳机", packageCount: 0, productQuantity: 5 } },
    { label: "箱数 -2", row: { itemName: "耳机", packageCount: -2, productQuantity: 5 } },
    { label: "箱数 2.5", row: { itemName: "耳机", packageCount: 2.5, productQuantity: 5 } },
    { label: "箱数没填", row: { itemName: "耳机", productQuantity: 5 } },
    { label: "每箱几个 0", row: { itemName: "耳机", packageCount: 3, productQuantity: 0 } },
    { label: "每箱几个 -3", row: { itemName: "耳机", packageCount: 3, productQuantity: -3 } },
    { label: "每箱几个 1.5", row: { itemName: "耳机", packageCount: 3, productQuantity: 1.5 } },
  ];

  await checkAsync("11) 客户建单 /client/prealerts：非法箱数一律 400，绝不能存成 1 箱", async () => {
    const handler = routeTable.get("POST /client/prealerts");
    assert.ok(handler, "没注册 /client/prealerts");
    for (const { label, row } of BAD_ROWS) {
      const r = await callRoute(handler!, CLIENT, {
        warehouseId: "w_1", transportMode: "sea", itemName: "耳机", products: [row],
      });
      assert.equal(
        r.status,
        400,
        `【${label}】没被拦下，拿到 ${r.status} —— 这条路会把它存成 1 箱（第七轮复核实测过）`,
      );
      assertIsProductRowError(label, r.message);
    }
  });

  await checkAsync("12) 员工建单 /staff/orders：同一组非法输入同样 400", async () => {
    const handler = routeTable.get("POST /staff/orders");
    assert.ok(handler, "没注册 /staff/orders");
    for (const { label, row } of BAD_ROWS) {
      const r = await callRoute(handler!, STAFF, {
        clientId: "u_test_client", trackingNo: "TH0001", warehouseId: "w_1",
        transportMode: "sea", itemName: "耳机", products: [row],
      });
      assert.equal(r.status, 400, `【${label}】没被拦下，拿到 ${r.status}`);
      assertIsProductRowError(label, r.message);
    }
  });

  await checkAsync("13) 管理员改单 /admin/orders/update：同一组非法输入同样 400", async () => {
    const handler = routeTable.get("POST /admin/orders/update");
    assert.ok(handler, "没注册 /admin/orders/update");
    for (const { label, row } of BAD_ROWS) {
      const r = await callRoute(handler!, ADMIN, {
        orderId: "o_test", trackingNo: "TH0001", products: [row],
      });
      assert.equal(r.status, 400, `【${label}】没被拦下，拿到 ${r.status}`);
      assertIsProductRowError(label, r.message);
    }
  });

  await checkAsync("14) 正常输入不许被误伤（而且全程不许碰数据库）", async () => {
    /**
     * ⚠️⚠️ 这一项第一版**真的连上了 Neon 测试库**，跑到 `prisma.order.create`
     * 才被外键拦住（2026-08-29）。`test-ai-chat-limits.ts` 开头记着同一个教训：
     *   「初版没这么写，结果真跑去连了 Neon 测试库」。
     * 同一个坑这个项目里第二次踩了。
     *
     * 正确的做法：给一份**产品行合法、但别的必填项故意缺失**的请求。
     * 于是它一定会在「缺必填项」那道闸停下（那道闸也在连库之前），
     * 拿到的报错**不是**产品行那几句 —— 这就证明产品行校验放行了，
     * 而且全程一次库都没连。
     */
    const good = { itemName: "耳机", packageCount: 3, productQuantity: 5 };
    const handler = routeTable.get("POST /client/prealerts")!;
    // 故意不给 warehouseId：它会在「missing required prealert fields」那里停下
    const r = await callRoute(handler, CLIENT, {
      transportMode: "sea", itemName: "耳机", products: [good],
    });
    assert.equal(r.status, 400, `期望停在「缺必填项」那道闸，实际 ${r.status}`);
    assert.ok(
      !/箱数|每箱几个/.test(r.message),
      `合法的产品行被产品校验挡住了 —— 校验写太严，员工要干不了活：${r.message}`,
    );
    assert.ok(
      /missing required|必填/.test(r.message),
      `停错地方了，拿到的是：${r.message}`,
    );
  });

  await checkAsync("15) 没有产品行时，订单级箱数同样要卡（三条路都测）", async () => {
    /**
     * 第八轮复核真调路由测出来的：
     *   · 客户建单无产品行，packageCount=2147483648 → 200
     *   · 员工建单无产品行，packageCount=0、2.5     → 200
     * 上一轮我只卡了**产品行**，没卡「没有产品行时那个订单级的箱数」——
     * 而管理员那条旧批量导入走的正是这条路（它完全不传 products 数组）。
     */
    const BAD_PKG: Array<[string, unknown]> = [
      ["0", 0],
      ["-3", -3],
      ["2.5", 2.5],
      ["超 32 位上限", 2147483648],
      ["没填", undefined],
    ];
    const client = routeTable.get("POST /client/prealerts")!;
    const staff = routeTable.get("POST /staff/orders")!;
    for (const [label, pkg] of BAD_PKG) {
      const c = await callRoute(client, CLIENT, {
        warehouseId: "w_1", transportMode: "sea", itemName: "耳机", packageCount: pkg,
      });
      assert.equal(c.status, 400, `客户建单【箱数 ${label}】没被拦，拿到 ${c.status}`);
      assert.ok(/箱数/.test(c.message), `客户建单【箱数 ${label}】被别的闸拦了：${c.message}`);

      const st = await callRoute(staff, STAFF, {
        clientId: "u_test_client", trackingNo: "TH0001", warehouseId: "w_1",
        transportMode: "sea", itemName: "耳机", packageCount: pkg,
      });
      assert.equal(st.status, 400, `员工建单【箱数 ${label}】没被拦，拿到 ${st.status}`);
      assert.ok(/箱数/.test(st.message), `员工建单【箱数 ${label}】被别的闸拦了：${st.message}`);
    }
  });

  await checkAsync("16) 单行都合法但**合计**溢出，也要拦", async () => {
    /**
     * 复核实测：两个产品行各 15 亿箱 → 每行都 < 21 亿、单行校验全过，
     * 合计 30 亿写进 Order.packageCount（Int）就爆了，返回 200。
     * ⚠️ 两行故意用**不同**的数（15 亿 / 16 亿），相同的数会假绿。
     */
    const handler = routeTable.get("POST /client/prealerts")!;
    const r = await callRoute(handler, CLIENT, {
      warehouseId: "w_1", transportMode: "sea", itemName: "耳机",
      products: [
        { itemName: "耳机", packageCount: 1500000000, productQuantity: 1 },
        { itemName: "手机壳", packageCount: 1600000000, productQuantity: 1 },
      ],
    });
    assert.equal(r.status, 400, `合计溢出没被拦，拿到 ${r.status}`);
    assert.ok(/合计/.test(r.message), `拦是拦了，但不是合计那道闸：${r.message}`);

    /**
     * 合计**没有**溢出的正常单子不许误伤：3 + 4 = 7。
     * ⚠️ 故意不给 warehouseId，让它停在「缺必填项」那道闸（也在连库之前）——
     * 给全了它就会一路走到 `prisma.order.create` **真的去连库**。
     * 这个坑我这轮已经踩第三次了：test-ai-chat-limits.ts 开头就记着同一条教训。
     */
    const ok2 = await callRoute(handler, CLIENT, {
      transportMode: "sea", itemName: "耳机",
      products: [
        { itemName: "耳机", packageCount: 3, productQuantity: 2 },
        { itemName: "手机壳", packageCount: 4, productQuantity: 5 },
      ],
    });
    assert.ok(!/箱数|合计/.test(ok2.message), `正常单子被数值闸误伤了：${ok2.message}`);
    assert.ok(/missing required|必填/.test(ok2.message), `没停在「缺必填项」那道闸，而是：${ok2.message}`);
  });

  await checkAsync("17) 装柜件数不许是小数", async () => {
    /**
     * 复核实测 loadedPieceCount=2.5 能进事务。
     * ShipmentContainerItem.loadedPieceCount 是 Int，小数要么写库 500，
     * 要么先把「已装几件 / 还剩几件」算成小数。
     */
    const handler = routeTable.get("POST /admin/containers/load");
    assert.ok(handler, "没注册 /admin/containers/load");
    /**
     * ⚠️ 第一版只断言「拿到 400」，**没看报错内容、也没有正向对照** ——
     * 第九轮复核实测：把这个接口改成无条件返回 400，这一项照样全绿。
     * 这正是本文件 252-259 行写着「光看 400 是不够的」并为此加了
     * assertIsProductRowError 的那条教训，第 17 项当时忘了用。
     */
    const BAD_PIECES: Array<[string, unknown]> = [
      ["2.5", 2.5],
      ["0", 0],
      ["-1", -1],
      ["超上限", 2147483648],
      // ⚠️ Number(true) === 1，先转再判的写法会把布尔当成 1 件放行
      ["布尔 true", true],
      ["数组 [5]", [5]],
    ];
    for (const [label, pieces] of BAD_PIECES) {
      const r = await callRoute(handler!, ADMIN, {
        containerId: "c_1", shipmentId: "s_1", loadedVolumeM3: 1.2, loadedPieceCount: pieces,
      });
      assert.equal(r.status, 400, `装柜件数【${label}】没被拦，拿到 ${r.status}`);
      assert.ok(
        /件数/.test(r.message),
        `装柜件数【${label}】是被 400 了，但报错不是件数那道闸发的：${JSON.stringify(r.message)}`,
      );
    }

    /**
     * **正向对照**：合法件数不许被这道闸拦。
     * ⚠️ 故意不给 containerId，让它停在「参数缺失」那道闸（也在连库之前），
     * 拿到的报错**不该**提「件数」—— 这就证明合法的 3 件放行了。
     */
    const good = await callRoute(handler!, ADMIN, {
      shipmentId: "s_1", loadedVolumeM3: 1.2, loadedPieceCount: 3,
    });
    assert.ok(
      !/件数必须/.test(good.message),
      `合法的 3 件被件数闸拦住了：${good.message}`,
    );
  });

  await checkAsync("18) 查不到的运单必须当场报错，不许悄悄丢掉（直接单测共用函数）", async () => {
    /**
     * ⚠️⚠️ **这是我上一轮抽出 lockShipmentsChildrenFirst 时引入的回归。**
     * 原来建派送单是循环里逐个 findFirst，找不到抛 404、整批失败。
     * 改成批量 findMany 之后，查不到的 id 直接不在结果里 ——
     * 第九轮复核用真实路由夹具打出来：
     *   全是无效 id → **200，建出一张 count: 0 的空派送单**
     *   有效无效混着 → **部分成功**，无效那几票一声不吭地没了
     *
     * ⚠️ 第一版我是去调整条路由，结果**测不出东西**：
     * 本脚本禁了数据库，路由走到 findMany 就抛连库错误，
     * 我的断言只写了 `status !== 200`，连库失败也满足 —— 假绿。
     * 现在直接给这个函数喂一个**假 tx**：它不连库，
     * 而且能精确控制「查到了哪几行」，才真正测得到那道检查。
     */
    const { lockShipmentsChildrenFirst, ShipmentsNotFoundError } = await import(
      "../apps/api/src/modules/shipments/lock-shipments"
    );

    /** 假 tx：findMany 只返回 present 里那几行，$queryRaw 记下锁了谁 */
    const makeTx = (present: Array<{ id: string; trackingNo: string; parentTrackingNo: string | null }>) => {
      const locked: string[] = [];
      return {
        locked,
        tx: {
          shipment: { findMany: async () => present },
          $queryRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
            locked.push(String(vals[0]));
            return [];
          },
        },
      };
    };

    // ① 全是查不到的 → 必须抛，不许安安静静返回空数组
    {
      const { tx, locked } = makeTx([]);
      await assert.rejects(
        () => lockShipmentsChildrenFirst(tx as any, ["s_no_1", "s_no_2"], "c_test"),
        (e: unknown) => e instanceof ShipmentsNotFoundError,
        "传全是无效运单时没有报错 —— 调用方会拿着空清单建出一张空派送单",
      );
      assert.deepEqual(locked, [], "都没查到还去锁了东西");
    }

    // ② 有效无效混着 → 同样必须整批失败，不许部分成功
    {
      const { tx } = makeTx([{ id: "s_ok", trackingNo: "TH1", parentTrackingNo: null }]);
      await assert.rejects(
        () => lockShipmentsChildrenFirst(tx as any, ["s_ok", "s_no"], "c_test"),
        (e: unknown) => e instanceof ShipmentsNotFoundError && /s_no/.test((e as Error).message),
        "有效无效混着传时只成功了一半 —— 无效那几票一声不吭地没了",
      );
    }

    // ③ 全都查得到 → 正常放行，而且**先锁子单再锁父单、层内按 id 排**
    {
      // ⚠️ 故意让父单的 id 排在子单前面（s_a < s_b），
      //    混排的话锁序会是 a,b；正确的应该是先子单 s_b、再父单 s_a
      const { tx, locked } = makeTx([
        { id: "s_a", trackingNo: "TH_P", parentTrackingNo: null },
        { id: "s_b", trackingNo: "TH_C", parentTrackingNo: "TH_P" },
      ]);
      const ordered = await lockShipmentsChildrenFirst(tx as any, ["s_a", "s_b"], "c_test");
      assert.deepEqual(ordered, ["s_b", "s_a"], "没有「先全部子单、再全部父单」");
      assert.deepEqual(locked, ["s_b", "s_a"], "实际发出去的锁顺序不对");
    }

    // ④ 多层分柜（既是子单又是父单）要当场报错，不许安安静静去死锁
    {
      const { tx } = makeTx([
        { id: "s_1", trackingNo: "TH_A", parentTrackingNo: null },
        { id: "s_2", trackingNo: "TH_B", parentTrackingNo: "TH_A" },
        { id: "s_3", trackingNo: "TH_C", parentTrackingNo: "TH_B" },
      ]);
      await assert.rejects(
        () => lockShipmentsChildrenFirst(tx as any, ["s_1", "s_2", "s_3"], "c_test"),
        /多层分柜/,
        "中间单（既是子单又是父单）没被拦住",
      );
    }
  });

  await checkAsync("19) 管理员改单的**订单级**箱数/产品数量同样要卡", async () => {
    /**
     * 第九轮复核实测：/admin/orders/update 的 productQuantity=2.5、
     * packageCount=2.5、超 32 位上限全都能过 —— 我前面几项只测了 `products` 产品行，
     * 没测「订单级那两个字段」。
     * ⚠️ 这道校验原来夹在查库之后，现在挪到了碰库之前，所以这里测得到。
     */
    const handler = routeTable.get("POST /admin/orders/update")!;
    const BAD: Array<[string, string, unknown]> = [
      ["箱数 2.5", "packageCount", 2.5],
      ["箱数 -1", "packageCount", -1],
      ["箱数 超上限", "packageCount", 2147483648],
      ["箱数 布尔", "packageCount", true],
      ["产品数量 2.5", "productQuantity", 2.5],
      ["产品数量 超上限", "productQuantity", 2147483648],
      ["产品数量 数组", "productQuantity", [5]],
    ];
    for (const [label, field, value] of BAD) {
      const r = await callRoute(handler, ADMIN, { orderId: "o_test", [field]: value });
      assert.equal(r.status, 400, `【${label}】没被拦，拿到 ${r.status}`);
      assert.ok(
        /箱数|产品数量/.test(r.message),
        `【${label}】是被 400 了，但报错不是数值闸发的：${JSON.stringify(r.message)}`,
      );
    }
    /**
     * 正向对照：0 是允许的（表示没填），不许被误拦。
     * ⚠️ 故意**不给 orderId**，让它停在「orderId is required」那道闸（也在连库之前）——
     * 给全了它就会一路走到 `prisma.order.findFirst` 真的去连库。
     * 这个坑我这两轮已经踩到第四次了，所以脚本开头才加了那道「连不通的数据库地址」硬闸。
     */
    const zero = await callRoute(handler, ADMIN, { productQuantity: 0, packageCount: 7 });
    assert.ok(!/产品数量|箱数/.test(zero.message), `合法的 0 / 7 被数值闸拦了：${zero.message}`);
    assert.ok(/orderId/.test(zero.message), `没停在「缺 orderId」那道闸，而是：${zero.message}`);
  });

  await checkAsync("20) 确认收货：0 / 小数 / 超上限 / 布尔 一律拦下", async () => {
    /**
     * 第九轮复核用真实 handler 夹具传一整套 0 进来，**返回 200**，
     * 订单和运单的件数、重量、方数全部准备写成 0，还准备写一条到仓轨迹。
     *
     * ⚠️ 收到的货不可能是 0 件、0 公斤、0 方。而仓库版集货是
     * 「**方数 × 单价**」收费的 —— 方数被写成 0，这一票就等于白送。
     * 这不是「报个 500」那种毛病，是**安安静静算错钱**。
     */
    const handler = routeTable.get("POST /staff/prealerts/receive");
    assert.ok(handler, "没注册 /staff/prealerts/receive");
    const BAD: Array<[string, Record<string, unknown>]> = [
      ["件数 0", { packageCount: 0 }],
      ["件数 2.5", { packageCount: 2.5 }],
      ["件数 超上限", { packageCount: 2147483648 }],
      ["件数 布尔", { packageCount: true }],
      ["产品数量 0", { productQuantity: 0 }],
      ["重量 0", { weightKg: 0 }],
      ["重量 负数", { weightKg: -1 }],
      ["体积 0", { volumeM3: 0 }],
      ["体积 布尔", { volumeM3: true }],
      // 复核夹具打的就是这一整套
      ["整套全 0", { packageCount: 0, productQuantity: 0, weightKg: 0, volumeM3: 0 }],
    ];
    for (const [label, patch] of BAD) {
      const r = await callRoute(handler!, STAFF, { orderId: "o_test", ...patch });
      assert.equal(r.status, 400, `确认收货【${label}】没被拦，拿到 ${r.status}`);
      assert.ok(
        /件数|箱数|产品数量|重量|体积/.test(r.message),
        `【${label}】是被 400 了，但报错不是数值闸发的：${JSON.stringify(r.message)}`,
      );
    }

    /**
     * 正向对照：合法数值不许被误伤。
     * ⚠️ 故意不给 orderId，停在「orderId is required」（在连库之前）。
     */
    const good = await callRoute(handler!, STAFF, {
      packageCount: 7, productQuantity: 30, weightKg: 12.5, volumeM3: 0.86,
    });
    assert.ok(
      !/必须/.test(good.message),
      `合法的一套数值被拦了：${good.message}`,
    );
    assert.ok(/orderId/.test(good.message), `没停在「缺 orderId」那道闸：${good.message}`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/21 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("产品行校验：21 项全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
