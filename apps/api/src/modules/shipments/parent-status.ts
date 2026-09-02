import {
  SHIPMENT_STATUS_FLOW,
  SHIPMENT_STATUS_FLOW_LAND,
} from "../../../../../packages/shared-types/shipment-status";

/**
 * 一组子单里，**走得最慢的那个状态**（2026-08-25 从 syncParentStatusFromChildren 抽出来）。
 *
 * 抽出来是因为现在有两个地方要用同一条规则：
 *   ① 父单状态推算（本文件的 syncParentStatusFromChildren）
 *   ② AI 汇总时把父子合并成「一票货」，要决定这票货算什么状态（ai-service.ts）
 * 两边各写一份，早晚会出现「运单列表说已到仓、AI 说已签收」这种自己打自己脸的事。
 *
 * ⚠️ 海运 23 步、陆运 17 步是两套流程，必须按 transportMode 取对应那条线来比快慢
 *（交接文档红线 2.12：海运是海运，陆运是陆运，不许串）。
 *
 * ⚠️ 「不参与比较」的只有**退回**和**取消** —— 这两种是货不会再往前走了，
 *    拿它们当「最慢」会把整票钉死。只有当全部子单都是这种状态时才用它。
 *
 * ⚠️ **`exception`（异常）要参与比较。** 早期版本把整个 SHIPMENT_EXCEPTION_STATUSES
 *    一起排除，连异常也排掉了 —— 一个子单出异常、其他子单已签收时，
 *    整票会显示「已签收」，等于把问题藏起来。异常不在流程表里，会落进下面的
 *    「未知状态」分支被当成最慢的，于是整票跟着显示异常，这正是想要的效果。
 *
 * @returns 最慢的那个状态；传进来是空数组时返回 null
 */
export function pickSlowestStatus(
  statuses: string[],
  transportMode: string | null | undefined,
): string | null {
  if (statuses.length === 0) return null;

  const flow: string[] =
    transportMode === "land" ? SHIPMENT_STATUS_FLOW_LAND : SHIPMENT_STATUS_FLOW;

  const dead = new Set<string>(["returned", "cancelled"]);
  const alive = statuses.filter((s) => !dead.has(s));

  // 全部都已退回/取消：按固定优先级选，不能取第 0 个 ——
  // 传进来的顺序没有保证，同时存在退回和取消时结果会随数据库返回顺序变化。
  // 退回优先于取消：货真的退回来了，比「单子作废」更需要被看见。
  if (alive.length === 0) {
    return statuses.includes("returned") ? "returned" : "cancelled";
  }

  // 取流程上最靠前的那个 = 走得最慢的那个。
  // 流程表里查不到的状态（历史脏数据、异常）按「最慢」处理：
  // 宁可显示得保守，也不要谎报已送达。
  let slowest = alive[0];
  let slowestIdx = Number.MAX_SAFE_INTEGER;
  for (const s of alive) {
    const idx = flow.indexOf(s);
    const rank = idx === -1 ? -1 : idx;
    if (rank < slowestIdx) {
      slowestIdx = rank;
      slowest = s;
    }
  }
  return slowest;
}

/**
 * 按**全部子单**重新推算父单状态并落库（2026-08-22 新增）。
 *
 * ## 为什么要有这个函数
 *
 * 分柜之后，父单状态原来是「哪个子单最后被操作，就用它的状态覆盖父单」——
 * 等于**任何一个子单签收，整张父单立刻变成「已签收」**。
 * 2026-08-22 生产实测：7 张父单显示「已签收」，但子单还在「已到仓」或「预约派送」。
 * 客户在订单列表看到「已签收」，点开轨迹却看到货还在仓库 —— **这是客户直接看得到的错误**。
 *
 * ## 规则：跟着走得最慢的那个子单
 *
 * 客户问的是「我的货到哪了」，只要还有一件没到，整票就不算到。所以取所有子单里
 * 在流程上**走得最靠前（最慢）**的那个状态。全部子单都签收了，父单才签收。
 *
 * ⚠️ 海运 23 步、陆运 17 步是两套流程，必须按父单的 transportMode 取对应那条线来比快慢
 *（交接文档红线 2.12：海运是海运，陆运是陆运，不许串）。
 *
 * ⚠️ 已取消 / 退回的子单**不参与**比较 —— 它们不会再往前走了，
 *    拿它们当「最慢」会把父单永远钉死。只有当全部子单都是这种状态时才用它。
 *
 * ⚠️ 必须在事务里调用，并且传 tx；父单和子单要在同一个事务里读写，
 *    否则并发装柜/签收会互相覆盖。
 *
 * @returns 父单最终的状态；没有子单或找不到父单时返回 null（调用方无需处理）
 */
export async function syncParentStatusFromChildren(
  tx: any,
  parentTrackingNo: string,
  companyId: string,
): Promise<string | null> {
  /**
   * ⚠️ 第一件事就是**锁住父单这一行**，锁到之后再读父单和子单。
   *
   * 不加锁会漏更新：同一票货的两个子单在不同柜子里，两个柜子同时推进时——
   *   事务A 改子单1=已签收，读到子单2 还是「已到仓」（B 尚未提交）→ 算出父单=已到仓
   *   事务B 改子单2=已签收，读到子单1 还是「已到仓」（A 尚未提交）→ 算出父单=已到仓
   *   两个都提交后，两个子单都已签收，**父单却停在「已到仓」**。
   * 生产实测：33 张父单有多个子单，且全部横跨至少两个柜子，触发条件真实存在。
   *
   * 锁放在函数内部而不是让调用方各自加 —— 六个调用点里原来只有分柜那一处加了锁，
   * 靠调用方自觉一定会漏。
   */
  await tx.$queryRaw`
    SELECT id FROM shipments
    WHERE tracking_no = ${parentTrackingNo} AND company_id = ${companyId}
    FOR UPDATE
  `;

  const parent = await tx.shipment.findFirst({
    where: { trackingNo: parentTrackingNo, companyId },
    select: { id: true, currentStatus: true, transportMode: true, packageCount: true },
  });
  if (!parent) return null;

  /**
   * ⚠️ 父单自己还留着货时，**不要动它的状态**。
   *
   * 分柜是「从父单拆一部分出去」，拆完父单件数会相应减少。
   * 生产实测（2026-08-22）：849 张分柜父单里 **846 张自己已经 0 件**，
   * 货全在子单上 —— 这时候父单状态只是个汇总，该跟着最慢的子单走。
   * 但还有 **3 张父单自己留着货**（如 YW0001342 父单 71 件 + 子单 30 件）。
   * 那种情况下父单的状态是**它自己那批货**的真实状态，
   * 拿子单去覆盖它，等于把已经送到客户手上的货改回「在仓库」—— 那是把对的改错。
   *
   * 所以只在「父单自己没货了」时才接管它的状态。
   * ⚠️ 代价：父单还有货、同时某个子单卡住时，父单不会自动反映子单的落后。
   *    这 3 张目前父子状态是一致的，暂时没有影响；真出现分歧要单独跟用户确认口径。
   */
  if ((parent.packageCount ?? 0) > 0) return parent.currentStatus;

  const children = await tx.shipment.findMany({
    where: { parentTrackingNo, companyId },
    select: { currentStatus: true },
  });
  if (children.length === 0) return null;

  /**
   * 「不参与比较」的只有**退回**和**取消** —— 这两种是货不会再往前走了。
   *
   * ⚠️ 这里原来是把整个 SHIPMENT_EXCEPTION_STATUSES 展开，连 `exception`（异常）
   * 也一起排除掉了。那是错的：一个子单出了异常、其他子单已签收时，
   * 父单会**无视异常的那一票**直接显示「已签收」，等于把问题藏起来。
   * exception 要参与比较，而且它不在流程表里，会走下面的「未知状态」分支
   * 被当成最慢的 —— 父单跟着显示异常，这正是想要的效果。
   */
  const slowest = pickSlowestStatus(
    children.map((c: any) => c.currentStatus),
    parent.transportMode,
  );
  if (slowest === null) return null;

  if (slowest !== parent.currentStatus) {
    await tx.shipment.update({
      where: { id: parent.id },
      data: { currentStatus: slowest, updatedAt: new Date() },
    });
  }
  return slowest;
}
