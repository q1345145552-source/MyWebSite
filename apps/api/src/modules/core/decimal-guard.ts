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
/** 订单/运单的方数用的是这个规格，别拿 10,2 那套去卡它 */
export const DECIMAL_10_3: DecimalRule = { precision: 10, scale: 3 };
export const DECIMAL_10_6: DecimalRule = { precision: 10, scale: 6 };
/** 金额列用的是这个规格（最大 9999999999.99） */
export const DECIMAL_12_2: DecimalRule = { precision: 12, scale: 2 };

/**
 * ⚠️⚠️ **舍入必须跟真正写库那一步用同一个算法**（2026-08-29 第十二轮改）。
 *
 * 上一版我用的是 `Number(value.toFixed(scale))`，而生产代码算方数/金额用的是
 *   `Math.round((n + Number.EPSILON) * 10**s) / 10**s`
 * （whr-consolidation/utils.ts 的 round2 / round3 / calcItemVolumeM3）。
 * **两套算法在边界上不一样**，复核实测：
 *   · `9999.9999995` → toFixed 得 9999.999999（闸放行），
 *     实际算出来是 **10000** → 写 `Decimal(10,6)` 溢出
 *   · `0.0000005`   → toFixed 得 0（闸误拦），实际存的是 0.000001
 *
 * 闸和被闸的东西用两套算法，闸就是错的 —— 不是松就是紧。
 * 所以这里照抄生产那个算法，一个字都不改。
 * ⚠️ 哪天 round2/round3 改了算法，**这里必须跟着改**。
 */
function roundToScale(n: number, scale: number): number {
  const f = 10 ** scale;
  return Math.round((n + Number.EPSILON) * f) / f;
}

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
  if (roundToScale(n, rule.scale) !== n) {
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

/**
 * **算出来的字段也要卡**（2026-08-29 第十轮补，复核报的一条新的）。
 *
 * ⚠️ 这条最隐蔽：**每个输入都合法，算出来的那个数爆掉。**
 *   · 单重 99999999.99 × 数量 2 = 总重 199999999.98
 *     两个输入各自都在 `Decimal(10,2)` 范围内，
 *     但 `totalWeight` 那一列也是 `Decimal(10,2)` → 数据库实测 `numeric field overflow`
 *   · 1000 × 1000 × 1000 cm × 10 件 = 10000 m³
 *     长宽高各自都合法，而 `volume` 是 `Decimal(10,6)`，最大只能存 9999.999999 → 裸 500
 *
 * 只卡输入不卡输出，等于没卡。凡是「几个输入相乘/相加再写进库」的地方
 * 都要用这个函数把**结果**再过一遍。
 *
 * ⚠️ 只查**能不能存**（范围），不查小数位 —— 算出来的数带多少位小数
 * 是算式决定的，不是人填的，四舍五入到列精度是正常且预期的行为。
 */
export function requireDerivedWithinDecimal(
  value: number,
  label: string,
  rule: DecimalRule = DECIMAL_10_2,
): string | null {
  if (!Number.isFinite(value)) return `${label}算不出有效数字，请检查填写的数值`;

  /**
   * ⚠️⚠️ **要判断的是「四舍五入之后真正落库的那个值」，不是算出来的原值**
   * （2026-08-29 第十一轮改）。上一版只比原值，复核当场打穿两头：
   *
   *   · 下边界：0.01×0.01×0.01 cm × 1 件 = 1e-12 m³ —— 原值确实大于 0、
   *     确实小于上限，闸门放行；但 `Decimal(10,6)` 四舍五入之后
   *     **落库就是 0 方**。而仓库版集货按「方数 × 单价」收费，
   *     0 方 = 这一票白送。「不能是 0」我又只修了表面。
   *   · 上边界：9999.9999996 —— 原值小于 10000、放行；
   *     舍入到 6 位小数变成 **10000**，超出 `Decimal(10,6)` → 写库炸。
   *
   * 所以先按列精度舍一次，再拿**舍完的那个数**去判上下界。
   */
  const stored = roundToScale(value, rule.scale);

  if (stored === 0 && value !== 0) {
    const min = Number((10 ** -rule.scale).toFixed(rule.scale));
    return `${label}算出来只有 ${value}，存进系统会变成 0（这一列最小只能记到 ${min}）—— 请检查尺寸/重量是不是填错了单位`;
  }

  const maxValue = 10 ** (rule.precision - rule.scale);
  if (Math.abs(stored) >= maxValue) {
    return `${label}算出来是 ${stored}，超过了系统能存的上限 ${maxValue}，请把这一行拆小一点`;
  }
  return null;
}

/**
 * 「一批数加起来」也不许溢出（2026-08-29 第十一轮补）。
 *
 * ⚠️ 复核报的：我上一版只卡了**单行**，跨行汇总一个都没卡：
 *   · `recalcPrealertFee()`：101 方 × 99999999.99 = 10099999998.99，
 *     而金额列是 `Decimal(12,2)`，最大 9999999999.99 → **写库直接失败**
 *   · `recalcCustomerTotals()`：两行各 15 亿 / 16 亿件，合计 31 亿，
 *     而件数列是 `Int`，最大 2147483647 → 溢出
 * **每一行单独都合法，加起来才爆** —— 跟「派生值」是同一类，
 * 都是「只卡输入不卡输出」。
 */
/**
 * 「一批汇总值能不能写进库」—— **所有汇总点共用这一个**（2026-08-29 第十二轮抽出）。
 *
 * ⚠️ 为什么抽：第十一轮我给 whr 的两个汇总加了闸，
 * 第十二轮复核马上找出**另外两个漏掉的**（仓库签收直接算 totalFee、
 * 普通版 recalcTaskTotals）。
 * 「N 个入口只修了 M 个」这个错我在这个项目里已经犯过五六次 ——
 * 一份实现、每个汇总点调它，才不会再漏。
 *
 * @returns 有问题时返回中文提示；合格返回 null。
 */
export function checkTotalsWritable(totals: {
  /** 件数类（数据库 Int） */
  counts?: Array<[string, number]>;
  /** 方数类（Decimal(10,3)） */
  volumes?: Array<[string, number]>;
  /** 金额类（Decimal(12,2)） */
  fees?: Array<[string, number]>;
}): string | null {
  for (const [label, v] of totals.counts ?? []) {
    if (!Number.isFinite(v) || !Number.isInteger(v) || Math.abs(v) > PG_INT_MAX_FOR_TOTALS) {
      return `${label}算出来是 ${v}，超过了系统能存的上限 ${PG_INT_MAX_FOR_TOTALS}`;
    }
  }
  /**
   * ⚠️⚠️ **汇总只查「会不会溢出」，不查「会不会舍成 0」**（2026-08-29 上线前修）。
   *
   * 我第十二轮给汇总用了 `requireDerivedWithinDecimal`，那个函数带着一条
   * 「舍完变成 0 就报错」的检查 —— 那条对**单行**是对的（客户把厘米填成米之类），
   * 对**合计**是错的：
   *   上线前排查实测：一个 **7×7×7 厘米的样品盒** = 0.000343 方，
   *   任务汇总方数落在 0~0.0005 之间 → 我的闸报 400 → **员工签不了收**，
   *   而且报的是「请检查尺寸是不是填错了单位」这种听不懂的话。
   *
   * 为什么合计舍成 0 是可以接受的：**算钱不看这个汇总值**。
   * 费用走的是 `calcFeeFromItems`，按**每一行**的方数 × 单价算
   * （whr-consolidation/utils.ts:67-80）。汇总的 totalVolumeM3 只用来
   * 显示和算「柜子装了几成」。所以它舍成 0.000 只是显示精度，不是钱的问题。
   *
   * ⚠️ 单行那道闸（requireDerivedWithinDecimal）保持不变 ——
   *    「填错单位」要在**填的那一刻**拦住，不是等到汇总。
   */
  for (const [label, v] of totals.volumes ?? []) {
    const issue = requireSumUpperBound(v, label, DECIMAL_10_3);
    if (issue) return issue;
  }
  for (const [label, v] of totals.fees ?? []) {
    const issue = requireSumUpperBound(v, label, DECIMAL_12_2);
    if (issue) return issue;
  }
  return null;
}

/** 汇总值只查上限（溢出）。下限不查 —— 理由见 checkTotalsWritable 里那段。 */
function requireSumUpperBound(value: number, label: string, rule: DecimalRule): string | null {
  if (!Number.isFinite(value)) return `${label}算不出有效数字，请检查填写的数值`;
  const stored = roundToScale(value, rule.scale);
  const maxValue = 10 ** (rule.precision - rule.scale);
  if (Math.abs(stored) >= maxValue) {
    return `${label}算出来是 ${stored}，超过了系统能存的上限 ${maxValue}`;
  }
  return null;
}

/** PostgreSQL `integer` 上限，跟 int-guard 里那个是同一个数 */
const PG_INT_MAX_FOR_TOTALS = 2147483647;

export function requireSumWithinDecimal(
  values: number[],
  label: string,
  rule: DecimalRule = DECIMAL_10_2,
): string | null {
  let sum = 0;
  for (const v of values) sum += Number.isFinite(v) ? v : 0;
  return requireDerivedWithinDecimal(sum, label, rule);
}
