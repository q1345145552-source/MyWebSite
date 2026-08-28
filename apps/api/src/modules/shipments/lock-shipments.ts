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

/**
 * 按**运单号**给一批父单上锁 —— 但内部统一换算成 **id** 再排序。
 *
 * ⚠️⚠️ 为什么必须有这个（2026-08-29，第八轮之后的补刀）：
 *
 * 我上面那个 `lockShipmentsChildrenFirst` 的父单层是 `[...parentIds].sort()`，
 * 按 **id** 排。而系统里另外三处「第二轮同步父单」写的是
 *   `for (const no of [...parentNosToSync].sort()) await syncParentStatusFromChildren(...)`
 * （containers/routes.ts ~491 / ~744、admin-ops/routes.ts ~685），
 * 而 `syncParentStatusFromChildren` 内部发的是
 *   `SELECT id FROM shipments WHERE tracking_no = ... FOR UPDATE`
 * —— 按**运单号**排。
 *
 * **同一批父单、两把不同的钥匙。** 两个事务从不同的门进来，顺序照样能反：
 *   事务A（给两张父单建派送单）按 id 序锁 P1 → P2
 *   事务B（推进一个柜，柜里装着 P1 和 P2 各自的子单）先锁两个子单，
 *         再按运单号序锁 P2 → P1
 * 成环。
 *
 * 测试库只读查过：**id 顺序和运单号顺序相反的父单对有 41 对**，
 * 不是理论上可能，是数据里就有。
 *
 * 所以全系统父单层**只认 id 一个排序键**。调用方要是手里只有运单号，
 * 就走这个函数换算，不许自己按运单号排。
 */
export async function lockParentsByTrackingNo(
  tx: any,
  parentTrackingNos: string[],
  companyId: string,
): Promise<string[]> {
  if (parentTrackingNos.length === 0) return [];
  const rows = await tx.shipment.findMany({
    where: { trackingNo: { in: parentTrackingNos }, companyId },
    select: { id: true },
  });
  const ordered: string[] = [];
  // ⚠️ 按 id 排，跟 lockShipmentsChildrenFirst 的父单层同一把钥匙
  for (const sid of rows.map((r: any) => r.id).sort()) {
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
    ordered.push(sid);
  }
  return ordered;
}

/**
 * 「锁一批父单 + 逐个重算它们的状态」—— 调用方**只许用这一个入口**。
 *
 * ⚠️ 为什么把循环也收进来（2026-08-29）：
 * 分成「先调 lockParentsByTrackingNo，再自己写 for 循环」两步的话，
 * 哪天有人把前面那句预锁删了，循环就重新变成决定锁序的那个人 ——
 * 而它迭代的是**运单号**清单，又回到「两把钥匙」那个 bug。
 * 合成一个函数，调用方连写错的机会都没有。
 */
export async function lockAndSyncParents(
  tx: any,
  parentTrackingNos: string[],
  companyId: string,
  sync: (tx: any, trackingNo: string, companyId: string) => Promise<unknown>,
): Promise<void> {
  const unique = [...new Set(parentTrackingNos)];
  if (unique.length === 0) return;
  // ① 先按 id 把这批父单全锁住（唯一决定锁序的一步）
  await lockParentsByTrackingNo(tx, unique, companyId);
  // ② 再逐个重算。这时候锁已经全在手里，②的顺序对死锁没有影响。
  for (const trackingNo of unique) {
    await sync(tx, trackingNo, companyId);
  }
}
