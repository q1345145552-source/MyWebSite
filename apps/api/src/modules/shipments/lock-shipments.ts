/**
 * 「一次锁一批运单」的**唯一正确姿势**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么必须有这么个东西（2026-08-29，第八轮复核之后）
 * ════════════════════════════════════════════════════════════════════
 *
 * 全系统的锁序规矩是【全部子单（按 id 排）→ 全部父单（按 id 排）】。
 * 但这个规矩以前靠**每个调用点自己自觉**，于是接连出事：
 *
 *   · 第七轮：删订单把父单子单混在一起 `[...allIds].sort()`。
 *     看着很整齐，但**整齐 ≠ 跟别人一致** —— 复核开两个连接实测，
 *     PostgreSQL 报 `deadlock detected`。
 *
 *   · 第八轮：我改完删订单之后，在自测里开了张「审阅登记表」，
 *     给另外三处批量锁各写了一条「这批 id 里不会同时出现父单和它的子单」的理由。
 *     **三条理由全是错的**：
 *       - 建派送单：尾端页面取候选运单走 `/staff/shipments?all=1`，
 *         而后端 `all=1` 就是**明确不过滤父子**（shipments/routes.ts:427-429），
 *         父单和子单都能被勾选。复核在测试库查到 5 组父子单同时可派送，
 *         双连接实测又是一个真死锁。
 *       - 柜子那两条：`/admin/containers/load` **根本不检查父子关系**，
 *         父单和它的子单可以分别装进同一个柜。
 *
 * 教训：**靠人工推理的白名单，可靠性就等于那个人的推理。**
 * 我推了三条，三条全错。所以不再靠推理 —— 锁之前**真去查一遍父子关系**，
 * 调用方谁都不用再想「这批里会不会有父单」。
 */

/** 锁完之后返回按锁定顺序排好的 id（调用方一般用不上，测试和排查时有用） */
export async function lockShipmentsChildrenFirst(
  tx: any,
  shipmentIds: string[],
  companyId: string,
): Promise<string[]> {
  if (shipmentIds.length === 0) return [];

  const rows = await tx.shipment.findMany({
    where: { id: { in: shipmentIds }, companyId },
    select: { id: true, trackingNo: true, parentTrackingNo: true },
  });

  /**
   * ⚠️ 多层分柜（A 是 B 的父单，B 又是 C 的父单）会让「两层」这个模型失效：
   * B 既是子单又是父单，放进哪一层都可能跟别人反着。
   *
   * 主流程已经禁止了（装柜时 `if (locked.parentTrackingNo) throw 子运单不能再次装柜`），
   * 第八轮复核在测试库也确认 **0 个多层分柜**。
   * 但历史数据里万一冒出来一个，我宁可**当场报错**，也不要它安安静静地去死锁 ——
   * 死锁是随机出现的、查起来极难；报错至少指得出是哪一票货。
   */
  const trackingNosInBatch = new Set<string>(rows.map((r: any) => r.trackingNo));
  const middle = rows.filter(
    (r: any) =>
      r.parentTrackingNo &&
      trackingNosInBatch.has(r.trackingNo) &&
      rows.some((o: any) => o.parentTrackingNo === r.trackingNo),
  );
  if (middle.length > 0) {
    throw new Error(
      `运单 ${middle.map((r: any) => r.trackingNo).join("、")} 既是子单又是父单（多层分柜），` +
        `加锁顺序无法确定，请先联系技术处理这几票货`,
    );
  }

  /**
   * 第一层：子单（有 parentTrackingNo 的）；第二层：父单和独立单。
   * ⚠️ 两层内部都必须按 id 排序 —— 同一层里顺序不固定，同样会反向等待。
   * ⚠️ 排序写在 `.sort()` 上、不靠 SQL 的 orderBy：
   *    test-lock-order 第 6 项按「取锁的循环里必须看得见 .sort()」查，
   *    而且要求**以 `.sort()` 结尾**（`.sort().reverse()` 那种会被逮住）。
   */
  const childIds = rows.filter((r: any) => r.parentTrackingNo).map((r: any) => r.id);
  const parentIds = rows.filter((r: any) => !r.parentTrackingNo).map((r: any) => r.id);

  const ordered: string[] = [];
  for (const sid of [...childIds].sort()) {
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    ordered.push(sid);
  }
  for (const sid of [...parentIds].sort()) {
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    ordered.push(sid);
  }
  return ordered;
}
