import assert from "node:assert/strict";
import { parseStaffBatchRows } from "../apps/web/src/modules/staff/batchOrderImport";

function buildRows(orderCount: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i <= orderCount; i += 1) {
    const trackingNo = `UTMULTI${String(i).padStart(5, "0")}`;
    const common = {
      "唛头 *": "TEST413CLIENT",
      "运单号 *": trackingNo,
      "仓库 *": "义乌仓",
      "到仓日期 *（YYYY-MM-DD）": "2026-08-27",
      "运输方式 *（海运/陆运）": "海运",
      "包装类型（箱/袋，默认箱）": "箱",
    };
    rows.push({
      ...common,
      "品名 *": `测试桌-${i}`,
      "箱数 *": 2,
      "长cm（数字）": 100,
      "宽cm（数字）": 50,
      "高cm（数字）": 20,
      "单箱重量kg *（数字）": 10,
      产品数量: 2,
    });
    rows.push({
      ...common,
      "品名 *": `测试桌-${i}`,
      "箱数 *": 3,
      "长cm（数字）": 120,
      "宽cm（数字）": 60,
      "高cm（数字）": 25,
      "单箱重量kg *（数字）": 12,
      产品数量: 3,
    });
    rows.push({
      ...common,
      "品名 *": `测试椅-${i}`,
      "箱数 *": 4,
      "长cm（数字）": 60,
      "宽cm（数字）": 55,
      "高cm（数字）": 90,
      "单箱重量kg *（数字）": 8,
      产品数量: 4,
    });
  }
  return rows;
}

const bulk = parseStaffBatchRows(buildRows(100));
assert.equal(bulk.sourceRowCount, 300);
assert.deepEqual(bulk.issues, []);
assert.equal(bulk.orders.length, 100);
assert.equal(bulk.orders.every((order) => order.products.length === 3), true);

/**
 * ⚠️ 原来只逐字核对**第 1 单**，剩下 99 单只看了「有没有 3 行明细」。
 * 解析器只要在第 2 单往后串行（把上一单的明细带过来、序号错位、公共字段继承错），
 * 100 单里 99 单是错的也照样绿。2026-08-28 补严：**100 单逐单核对**。
 *
 * 每单的数字都一样（箱数 2+3+4=9、重量 2×10+3×12+4×8=88、
 * 体积 2×1.00×0.50×0.20 + 3×1.20×0.60×0.25 + 4×0.60×0.55×0.90 = 1.928），
 * 只有品名带序号 —— 所以品名是唯一能抓出「串单」的那一列，必须逐单比。
 */
for (let i = 1; i <= 100; i += 1) {
  const order = bulk.orders[i - 1]!;
  const where = `第 ${i} 单`;
  assert.equal(order.trackingNo, `UTMULTI${String(i).padStart(5, "0")}`, `${where} 运单号不对`);
  assert.equal(order.packageCount, 9, `${where} 箱数不对`);
  assert.equal(order.productQuantity, 9, `${where} 产品数量不对`);
  assert.equal(order.weightKg, 88, `${where} 重量不对`);
  assert.ok(Math.abs((order.volumeM3 ?? 0) - 1.928) < 1e-9, `${where} 体积不对：${order.volumeM3}`);
  assert.deepEqual(
    order.products.map((product) => ({
      itemName: product.itemName,
      packageCount: product.packageCount,
      lengthCm: product.lengthCm,
      widthCm: product.widthCm,
      heightCm: product.heightCm,
      weightKg: product.weightKg,
    })),
    [
      { itemName: `测试桌-${i}`, packageCount: 2, lengthCm: 100, widthCm: 50, heightCm: 20, weightKg: 10 },
      { itemName: `测试桌-${i}`, packageCount: 3, lengthCm: 120, widthCm: 60, heightCm: 25, weightKg: 12 },
      { itemName: `测试椅-${i}`, packageCount: 4, lengthCm: 60, widthCm: 55, heightCm: 90, weightKg: 8 },
    ],
    `${where} 的明细行串了`,
  );
}

const inherited = parseStaffBatchRows([
  ...buildRows(1).slice(0, 1),
  {
    "品名 *": "后续明细可省略公共字段",
    "箱数 *": 1,
    "包装类型（箱/袋，默认箱）": "",
    "长cm（数字）": 10,
    "宽cm（数字）": 20,
    "高cm（数字）": 30,
    "单箱重量kg *（数字）": 2,
  },
]);
assert.deepEqual(inherited.issues, []);
assert.equal(inherited.orders.length, 1);
assert.equal(inherited.orders[0].products.length, 2);
assert.equal(inherited.orders[0].packageCount, 3);

const conflict = parseStaffBatchRows([
  ...buildRows(1).slice(0, 1),
  {
    ...buildRows(1)[1],
    "仓库 *": "广州仓",
  },
]);
assert.equal(conflict.orders.length, 0);
assert.equal(conflict.issues.some((issue) => issue.message.includes("仓库")), true);

console.log("staff batch import parser: 100 orders / 300 rows passed");
