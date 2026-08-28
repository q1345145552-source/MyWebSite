import { parseNumericStrict } from "./int-guard";

/**
 * 数据库 `Decimal` 字段的统一校验（2026-08-29，第九轮复核之后）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有：这几条都是**安安静静算错钱**，不是报错
 * ════════════════════════════════════════════════════════════════════
 *
 * 复核第九轮确认属实的 5 组里，有 3 组是小数精度问题：
 *
 * 1. **单价填 0.001 → 数据库存成 0.00**（`Decimal(10,2)` 直接四舍五入掉）。
 *    仓库版集货是「方数 × 单价」收费的，单价变 0 **这一柜等于白送**。
 *    而接口只判了「大于 0」，0.001 当然大于 0，一路放行。
 *
 * 2. **长宽高不限小数位** → 员工填 12.345，库里存成 12.35（`Decimal(10,2)`）。
 *    页面按 12.345 算方数、库里按 12.35 存尺寸，两个数对不上。
 *    复核实测：¥850/方 的柜子上，这个差价是 **¥5.10**。
 *    客户拿计算器照着单据上的尺寸算方数，永远对不上账。
 *
 * 3. **柜总方数没有上限** → 填大了，全系统唯一那道拦方数的闸就废了。
 *
 * ⚠️⚠️ **所有上限都从数据库字段本身推，一个业务数字都不编。**
 *   `Decimal(10,2)` 的含义是：一共 10 位有效数字、其中 2 位在小数点后
 *   → 整数部分最多 8 位（< 100000000）、小数最多 2 位
 *   → 能表示的**最小正数是 0.01**，比它小的一律被存成 0.00
 * 老板要是想再加**业务**上限（比如「一个柜最多 200 方」「单价不低于 50 元」），
 * 那是另一回事，得他给数字，不是我拍脑袋。
 */

export interface DecimalRule {
  /** 一共几位有效数字（Decimal(p, s) 的 p） */
  precision: number;
  /** 小数点后几位（Decimal(p, s) 的 s） */
  scale: number;
  /** 允许的最小值。不传 = 用这个精度能表示的最小正数（scale=2 → 0.01） */
  min?: number;
}

/** 项目里用到的几种字段规格，集中放这里，免得每处各写各的 */
export const DECIMAL_10_2: DecimalRule = { precision: 10, scale: 2 };
export const DECIMAL_10_6: DecimalRule = { precision: 10, scale: 6 };

/** 这个精度能表示的最小正数：scale=2 → 0.01，scale=6 → 0.000001 */
function smallestPositive(scale: number): number {
  return Number((10 ** -scale).toFixed(scale));
}

/** 整数部分最多几位 */
function maxIntegerDigits(rule: DecimalRule): number {
  return rule.precision - rule.scale;
}

/**
 * 校验一个要写进 `Decimal` 列的值。
 * @returns 有问题时返回给人看的中文提示；合格返回 null。
 */
export function requireDecimal(
  raw: unknown,
  label: string,
  rule: DecimalRule = DECIMAL_10_2,
): string | null {
  // ⚠️ 先严格转：Number(true) 是 1、Number([5]) 是 5，直接 Number() 挡不住
  const n = parseNumericStrict(raw);
  if (!Number.isFinite(n)) return `${label}必须是数字`;

  const min = rule.min ?? smallestPositive(rule.scale);
  if (n < min) {
    /**
     * ⚠️ 这句提示要说清「为什么」——员工填 0.001 被拒时，
     * 光说「必须大于 0」他会以为系统坏了（0.001 明明大于 0）。
     */
    return `${label}不能小于 ${min}（再小会被系统存成 0，这一笔就白算了）`;
  }

  const maxValue = 10 ** maxIntegerDigits(rule);
  if (n >= maxValue) {
    return `${label}不能达到 ${maxValue}（数据库最多存 ${maxIntegerDigits(rule)} 位整数）`;
  }

  /**
   * ⚠️ 小数位数必须卡死，不能靠「反正数据库会四舍五入」。
   * 四舍五入本身不报错，只会让**页面算的数**和**库里存的数**不一样 ——
   * 那正是客户对不上账的原因。
   * 判法：乘以 10^scale 之后必须是整数（用 EPSILON 兜浮点误差）。
   */
  const scaled = n * 10 ** rule.scale;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return `${label}最多只能有 ${rule.scale} 位小数（多的位数会被系统抹掉，跟你看到的对不上）`;
  }

  return null;
}

/**
 * 单价专用：除了上面那些，还要**明确不许是 0**。
 * 单价 0 意味着这一柜白送 —— 真要免费应该走别的流程，不该靠单价填 0。
 */
export function requireUnitPrice(raw: unknown, label: string): string | null {
  return requireDecimal(raw, label, DECIMAL_10_2);
}
