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

if (failures.length > 0) {
  console.error(`\n${failures.length}/10 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("产品行校验：10 项全部通过");
