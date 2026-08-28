/**
 * ⚠️⚠️ **硬闸：这个脚本一次数据库都不许连。**
 * 「不小心连上测试库」这个坑我这几轮踩到第四次，靠记性不行。
 * 一旦哪个用例走到写库，会当场炸出 `Can't reach database server`。
 * ⚠️ 必须在 import 任何会创建 PrismaClient 的模块**之前**设。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 集货那两套模块的「算钱数值」校验自测。
 *
 * 这一批是第九轮复核确认属实的 5 组 —— 它们的共同点是
 * **不会报错，只会安安静静算错钱**，比报 500 难发现得多：
 *
 *   1. 仓库版单价填 0.001 → `Decimal(10,2)` 存成 0.00 → **这一柜白送**
 *   2. 柜总方数没有上限   → 全系统唯一那道拦方数的闸失效
 *   3. 长宽高不限小数位   → 页面按 12.345 算方数、库里存 12.35，
 *                          客户拿计算器对不上账（复核实测 ¥850/方 差 ¥5.10）
 *   4. 普通版集货件数 `< 1` → **2.5 件**能存进 `Int` 列
 *   5. 普通版重量/长宽高   → 只查「填没填」，完全不查填的是什么
 *
 * ⚠️ 所有上限都是从**数据库字段定义**推出来的（Decimal(10,2) / Int），
 *    不是我编的业务数字。业务上限（比如「一个柜最多 200 方」）要老板给数。
 */
import assert from "node:assert/strict";
import {
  DECIMAL_10_2,
  DECIMAL_10_6,
  requireDecimal,
  requireUnitPrice,
} from "../apps/api/src/modules/core/decimal-guard";

type Handler = (req: any, res: any) => Promise<void> | void;

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try { body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}
async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

async function loadRoutes(): Promise<Map<string, Handler>> {
  const routes = new Map<string, Handler>();
  const fakeApp = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const whr = await import("../apps/api/src/modules/whr-consolidation/routes");
  const whrClient = await import("../apps/api/src/modules/whr-consolidation/client-routes");
  const cons = await import("../apps/api/src/modules/consolidation/routes");
  (whr as any).registerWhrConsolidationRoutes?.(fakeApp);
  (whrClient as any).registerWhrConsolidationClientRoutes?.(fakeApp);
  (cons as any).registerConsolidationRoutes?.(fakeApp);
  return routes;
}

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

console.log("算钱数值校验");

// ══════════════ 第一部分：闸本身（纯函数） ══════════════

check("1) 单价 0.001 必须拦下 —— 它会被 Decimal(10,2) 存成 0.00，这一柜白送", () => {
  /**
   * ⚠️ 这是复核实测的那个值。原来的校验是「大于 0」，
   * 而 0.001 确实大于 0，所以一路放行、存进去变成 0.00。
   * 提示语里必须说清「为什么」—— 光说「必须大于 0」员工会以为系统坏了。
   */
  const msg = requireUnitPrice(0.001, "普货单价");
  assert.ok(msg, "0.001 被放行了");
  assert.ok(/0\.01/.test(msg!), `提示里没说清最小能填多少：${msg}`);
  assert.ok(/存成 0/.test(msg!), `提示里没说清后果：${msg}`);
});

check("2) 单价的边界两头都要对", () => {
  // ⚠️ 边界两头都测：0.01 放行、0.009 拦下（只测一边看不出差一位）
  assert.equal(requireUnitPrice(0.01, "单价"), null, "刚好 0.01 被误拦");
  assert.ok(requireUnitPrice(0.009, "单价"), "0.009 被放行");
  assert.equal(requireUnitPrice(850, "单价"), null, "正常单价 850 被误拦");
  assert.equal(requireUnitPrice(99999999.99, "单价"), null, "上限内的数被误拦");
  assert.ok(requireUnitPrice(100000000, "单价"), "超过 8 位整数没被拦");
});

check("3) 小数位数必须卡死 —— 多的位数被抹掉就是客户对不上账的原因", () => {
  /**
   * 复核实测：¥850/方 的柜子上，尺寸多一位小数造成 **¥5.10** 差价。
   * 页面按 12.345 算方数、库里按 12.35 存尺寸，客户拿计算器永远对不出来。
   */
  assert.ok(requireDecimal(12.345, "长(cm)", DECIMAL_10_2), "3 位小数被放行");
  assert.equal(requireDecimal(12.34, "长(cm)", DECIMAL_10_2), null, "2 位小数被误拦");
  assert.equal(requireDecimal(12, "长(cm)", DECIMAL_10_2), null, "整数被误拦");
  // 方数那一列是 Decimal(10,6)，规格不一样，别拿 2 位那套去卡它
  assert.equal(requireDecimal(1.928456, "方数", DECIMAL_10_6), null, "6 位小数的方数被误拦");
  assert.ok(requireDecimal(1.9284567, "方数", DECIMAL_10_6), "7 位小数被放行");
  assert.ok(requireDecimal(10000, "方数", DECIMAL_10_6), "方数超 4 位整数没被拦");
});

check("4) 布尔/数组/空值不许当成数字", () => {
  // ⚠️ Number(true) 是 1、Number([5]) 是 5，直接 Number() 挡不住
  for (const bad of [true, [5], null, undefined, "", "abc", {}]) {
    assert.ok(
      requireDecimal(bad, "单价", DECIMAL_10_2),
      `${JSON.stringify(bad)} 被当成合法数字放行了`,
    );
  }
  // 数字字符串是可以的（前端经常这么传）
  assert.equal(requireDecimal("12.5", "单价", DECIMAL_10_2), null, "数字字符串被误拦");
});

// ══════════════ 第二部分：真调路由（证明闸接上了） ══════════════
// ⚠️ 只测「校验层」——合法数据往下走会连库，而本脚本禁了数据库。
//    所以正向对照一律用「数值合法但故意缺别的必填项」，停在连库之前那道闸。

async function main(): Promise<void> {
  const routes = await loadRoutes();
  const ADMIN = { userId: "u_admin", companyId: "c_test", role: "admin", name: "管理员" };
  const CLIENT = { userId: "u_client", companyId: "c_test", role: "client", name: "客户" };

  await checkAsync("5) 建柜接口：单价 0.001 和总方数超上限都要拦（真调路由）", async () => {
    const handler = routes.get("POST /admin/whr-consolidation/plans");
    assert.ok(handler, `没注册建柜路由，现有：${[...routes.keys()].slice(0, 8).join(", ")}`);
    /**
     * ⚠️ 字段名是从路由源码里抄的（routes.ts:91-100），不是我按印象写的。
     * 第一版我写成 `destination`，实际叫 `destinationTh`，
     * 结果所有用例都停在「目的地为必填」那道闸上 —— 测了个寂寞。
     */
    const base = {
      warehouse: "义乌", containerType: "40HQ", destinationTh: "曼谷",
      customers: [{ clientId: "u_client", unitPriceNormal: 850, unitPriceInspection: 900, unitPriceSensitive: 950 }],
    };
    // 单价 0.001
    const r1 = await callRoute(handler!, ADMIN, {
      ...base,
      customers: [{ clientId: "u_client", unitPriceNormal: 0.001, unitPriceInspection: 900, unitPriceSensitive: 950 }],
    });
    assert.equal(r1.status, 400, `单价 0.001 没被拦，拿到 ${r1.status}`);
    assert.ok(/单价/.test(r1.message), `拦是拦了，但不是单价那道闸：${r1.message}`);
    // 总方数超上限
    const r2 = await callRoute(handler!, ADMIN, { ...base, totalVolumeM3: 100000000 });
    assert.equal(r2.status, 400, `总方数 1 亿没被拦，拿到 ${r2.status}`);
    assert.ok(/总方数/.test(r2.message), `拦是拦了，但不是总方数那道闸：${r2.message}`);
    // 总方数 3 位小数
    const r3 = await callRoute(handler!, ADMIN, { ...base, totalVolumeM3: 68.123 });
    assert.equal(r3.status, 400, `总方数 3 位小数没被拦，拿到 ${r3.status}`);
  });

  await checkAsync("6) 普通版集货：2.5 件、负数重量、3 位小数尺寸都要拦（真调路由）", async () => {
    const handler = routes.get("POST /client/consolidation/prealerts");
    assert.ok(handler, `没注册普通版集货建单路由，现有：${[...routes.keys()].filter((k) => k.includes("consolidation")).slice(0, 10).join(", ")}`);
    const goodRow = {
      productName: "耳机", packageCount: 3, quantityPerBox: 10,
      unitWeightKg: 1.5, lengthCm: 30, widthCm: 20, heightCm: 10,
      material: "塑料", cargoValue: "1000",
    };
    const BAD: Array<[string, Record<string, unknown>]> = [
      ["件数 2.5", { packageCount: 2.5 }],
      ["件数 0", { packageCount: 0 }],
      ["件数 超上限", { packageCount: 2147483648 }],
      ["装箱数量 1.5", { quantityPerBox: 1.5 }],
      ["单件重量 -1", { unitWeightKg: -1 }],
      ["单件重量 0", { unitWeightKg: 0 }],
      ["单件重量 abc", { unitWeightKg: "abc" }],
      ["长 3 位小数", { lengthCm: 12.345 }],
      ["宽 0", { widthCm: 0 }],
      ["高 布尔", { heightCm: true }],
    ];
    for (const [label, patch] of BAD) {
      const r = await callRoute(handler!, CLIENT, {
        taskId: "t_1", mark: "XT001", products: [{ ...goodRow, ...patch }],
      });
      assert.equal(r.status, 400, `【${label}】没被拦，拿到 ${r.status}`);
      assert.ok(
        /产品行1/.test(r.message),
        `【${label}】是被 400 了，但报错不是产品行那道闸发的：${JSON.stringify(r.message)}`,
      );
    }
    /**
     * 正向对照：整行都合法时不许被数值闸拦。
     * ⚠️ 故意不给 taskId，让它停在别的必填项检查上（在连库之前）。
     */
    const good = await callRoute(handler!, CLIENT, { mark: "XT001", products: [goodRow] });
    assert.ok(
      !/产品行1/.test(good.message),
      `完全合法的一行被数值闸拦了：${good.message}`,
    );
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/6 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("算钱数值校验：6 项全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
