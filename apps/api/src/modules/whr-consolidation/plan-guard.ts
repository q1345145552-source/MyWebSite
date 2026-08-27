import { BusinessError } from "../core/business-error";

/* ==========================================================================
   整柜已取消时，不许再往里收钱（2026-08-27，第二版加锁）
   --------------------------------------------------------------------------
   老板口径：钱只在集货那两个功能里 —— 这两个功能里**碰钱的每一条路**
   都必须先确认「这个柜还算数吗」。

   ⚠️ 原来的洞：取消整个计划（柜）时，**底下的预报单状态不会跟着变** ——
   单子自己还是「已收货待付款」。于是柜都作废了：
     · 客户端仍显示「待付款」，客户还能真的付钱（余额真扣、流水真写）
     · 员工仍能签收计费、管理员仍能改价

   ⚠️⚠️ **第一版只是普通查询，有时间差**（外部复审实测复现）：
   读到「柜还活着」之后、真正动手之前，柜被另一个请求取消了，钱照样扣。
   第二版必须做到两件事：
     ① **在同一个事务里**调用（所以每个 tx 都得传进来，不给默认值）
     ② **`FOR UPDATE` 锁住计划那一行** —— 取消操作也要抢同一把锁，抢不到就得排队

   ⚠️ 统一锁序：**计划 → 预报单/客户/明细 → 钱包**。
   四条路都按这个顺序拿锁，避免两个事务反着拿导致死锁。
   所以闸门要放在「锁子单」之前，别放后面。

   ⚠️ 只拦「往里收钱」，**不拦退钱和作废**：
     拦：付款 / 签收计费 / 改单价重算 / 删货 / 付款审核
     不拦：撤销付款（退钱）、取消预报单 —— 柜取消了这些反而更该让它做完
   ========================================================================== */

/** 整柜作废时抛这个。继承 BusinessError → 最外层自动转 400，路由不用自己接 */
export class PlanCancelledError extends BusinessError {
  constructor(message = "这个柜已经取消了，不能再收款或计费。要退钱请走「撤销付款」。") {
    super(message, 400, "BAD_REQUEST");
  }
}

/** 计划记录都找不到时抛这个 —— 不能当成「活着」放行 */
export class PlanMissingError extends BusinessError {
  constructor(message = "找不到这个柜（可能已被删除），操作已取消。") {
    super(message, 404, "NOT_FOUND");
  }
}

type Tx = { $queryRaw: <T = any>(s: TemplateStringsArray, ...v: any[]) => Promise<T> };

/**
 * 锁住计划行并确认它还活着。**必须传事务**。
 *
 * ⚠️ 查不到记录时**抛错而不是放行**（第一版是放行的，外部复审指出这是漏洞）：
 * 查不到只有两种可能 —— 数据被删了，或者关系断了。两种都不该继续收钱。
 */
export async function lockPlanAliveById(tx: Tx, planId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM whr_consolidation_plans WHERE id = ${planId} FOR UPDATE
  `;
  if (!rows || rows.length === 0) throw new PlanMissingError();
  if (rows[0].status === "cancelled") throw new PlanCancelledError();
}

/**
 * 按预报单反查它所属的计划，锁住并确认还活着。**必须传事务**。
 * 一条 SQL 做完（第一版被 Prisma 拆成 3 条查询，窗口更长）。
 */
export async function lockPlanAliveByPrealert(tx: Tx, prealertId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT pl.status
    FROM whr_consolidation_prealerts pa
    JOIN whr_consolidation_plan_customers pc ON pc.id = pa.customer_id
    JOIN whr_consolidation_plans pl ON pl.id = pc.plan_id
    WHERE pa.id = ${prealertId}
    FOR UPDATE OF pl
  `;
  if (!rows || rows.length === 0) throw new PlanMissingError();
  if (rows[0].status === "cancelled") throw new PlanCancelledError();
}

/**
 * 只锁住这张预报单所属的**计划行**，不判断计划死活（2026-08-27）。
 *
 * 用在「取消预报单」这种场合：柜子已经作废了，底下的单子照样要能取消，
 * 所以不能用 lockPlanAliveByPrealert（那个会直接拒绝）。
 *
 * ⚠️ 但锁还是**必须**拿，而且必须第一个拿。全模块统一锁序是
 * 【计划 → 子单 → 钱包】：取消这条路后面会调 syncPlanStatus 去改计划行，
 * 如果不先锁计划、而是先锁子单，就跟「删除整柜」那条路（计划 → 子单）
 * 正好反着，两个人同时操作就是死锁（外部复审用真实 PostgreSQL 复现过 40P01）。
 */
export async function lockPlanByPrealert(tx: Tx, prealertId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT pl.status
    FROM whr_consolidation_prealerts pa
    JOIN whr_consolidation_plan_customers pc ON pc.id = pa.customer_id
    JOIN whr_consolidation_plans pl ON pl.id = pc.plan_id
    WHERE pa.id = ${prealertId}
    FOR UPDATE OF pl
  `;
  if (!rows || rows.length === 0) throw new PlanMissingError();
}

/**
 * 锁住一张预报单，并确认它**现在**还是预期的那个状态（2026-08-27）。
 *
 * 为什么要有这个函数：仓库版的每一步（装柜、发运、泰国签收…）原来都是
 * 「事务外面判一下状态 → 开事务直接改」。两个员工同时点不同的按钮，
 * 两边都是拿进门时那份旧状态去判断的，于是**两步都写进去了** ——
 * 状态跳步、轨迹里多出重复或错序的记录，客户那边看得见。
 *
 * 锁住之后重新读一遍，第二个人会看到状态已经变了，直接被拦下。
 * @param what 用在提示语里的动作名，比如「装柜」「发运」
 */
export async function lockPrealertExpecting(
  tx: Tx,
  prealertId: string,
  expected: string,
  what: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ${prealertId} FOR UPDATE`;
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM whr_consolidation_prealerts WHERE id = ${prealertId}`;
  if (!rows || rows.length === 0) {
    throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
  }
  if (rows[0].status !== expected) {
    throw new BusinessError(`这张预报单刚刚被别人处理过了，${what}没有执行，请刷新后再看`);
  }
}
