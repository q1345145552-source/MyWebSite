/**
 * 数据库整数字段的统一校验（2026-08-29，第八轮复核之后抽出来的）。
 *
 * 为什么要有：这个系统里「用户填的数值没校验就进数据库」这一类 bug 反复出现，
 * 每轮复核都能再找出几个入口。到第八轮时点名的有：
 *   · 员工建单没有产品行时，`packageCount` 填 0 / 2.5 都能过
 *   · 客户建单没有产品行时，`packageCount` 填 21 亿多能过
 *   · 两个产品行各 15 亿箱，**单行都合法、合计 30 亿溢出**
 *   · 仓库版集货只判了 `> 0`，2.5 箱 / 每箱 2.5 个 / 超上限都能过
 *   · 装柜接口 `loadedPieceCount` 填 2.5 能进事务
 *
 * 这些字段在 schema.prisma 里**全是 `Int`**（PostgreSQL 32 位 integer）：
 *   Order.packageCount / Order.productQuantity / OrderProduct.packageCount /
 *   ShipmentContainerItem.loadedPieceCount /
 *   WhrConsolidationPrealertItem.packageCount / quantityPerBox / totalQuantity …
 *
 * 后果分两种，都不能接受：
 *   · 超上限 → 一路穿到写库那一刻才炸，员工只看到「服务器繁忙」，
 *     根本不知道是自己填的数太大
 *   · 小数   → **不会报错**，而是让方数、重量、金额先按小数算错。
 *     仓库版集货是「方数 × 单价」收费的，这一条直接是钱的问题。
 *
 * ⚠️ 一律在**进数据库之前、最好在碰数据库之前**拦，并且报一句人看得懂的话。
 */

/** PostgreSQL `integer` 的上限 */
export const PG_INT_MAX = 2147483647;

/**
 * 必须是正整数且不超过 32 位上限。
 * @returns 有问题时返回给人看的中文提示；合格返回 null。
 */
export function requirePositiveInt(value: unknown, label: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return `${label}必须是正整数`;
  }
  if (value > PG_INT_MAX) return `${label}不能超过 ${PG_INT_MAX}`;
  return null;
}

/** 允许 0（表示「没填」），其余同上 */
export function requireNonNegativeInt(value: unknown, label: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return `${label}必须是不小于 0 的整数`;
  }
  if (value > PG_INT_MAX) return `${label}不能超过 ${PG_INT_MAX}`;
  return null;
}

/**
 * 合计不许溢出。
 * ⚠️ 单行都合法不代表合计合法：两行各 15 亿箱，每行都 < 21 亿，合计 30 亿就爆了。
 * 这一条是第八轮复核实测出来的，我原来只卡了单行。
 */
export function requireSumWithinInt(values: number[], label: string): string | null {
  let sum = 0;
  for (const v of values) sum += Number.isFinite(v) ? v : 0;
  if (sum > PG_INT_MAX) return `${label}合计 ${sum} 超过了系统上限 ${PG_INT_MAX}，请分单填写`;
  return null;
}

/**
 * 乘积不许溢出。
 * 仓库版集货存的 `totalQuantity = packageCount × quantityPerBox` 也是 Int，
 * 两个因子各自合法、乘起来照样能爆。
 */
export function requireProductWithinInt(a: number, b: number, label: string): string | null {
  const product = a * b;
  if (!Number.isFinite(product) || product > PG_INT_MAX) {
    return `${label}（${a} × ${b}）超过了系统上限 ${PG_INT_MAX}，请分单填写`;
  }
  return null;
}
