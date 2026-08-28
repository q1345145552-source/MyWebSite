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
  (orders as any).registerOrderRoutes(fakeApp);
  (admin as any).registerAdminRoutes(fakeApp);
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
        if (/packageCount\s*\)?\s*\|\|\s*1\b/.test(line) || /Math\.max\(\s*1\s*,[^)]*packageCount/.test(line)) {
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

  if (failures.length > 0) {
    console.error(`\n${failures.length}/14 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("产品行校验：14 项全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
