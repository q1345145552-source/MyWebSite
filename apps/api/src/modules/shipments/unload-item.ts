import { BusinessError } from "../core/business-error";

/**
 * 把**一条柜内记录**整个卸下来：件数/方数/重量还给父单，然后删掉子单。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么要有这个（2026-08-29）
 * ════════════════════════════════════════════════════════════════════
 *
 * 这段逻辑原来只写在「卸柜」那条路里（loading-manifests/routes.ts）。
 * 上线前排查发现 **「删除柜子」那条路完全没做这件事** ——
 * 它只删柜子和柜内记录，**子单原样留着**：
 *   · 子单变成孤儿：状态还写着「已装柜」，却不属于任何柜子
 *   · 父单被扣走的件数/方数/重量**永远回不来**（父单永远 0 件 0 方 0 公斤）
 * 而「建错柜子删掉重来」是员工很日常的动作，删除按钮就在卸柜按钮旁边，
 * 确认框还只说「此操作不可恢复」，没提会把货的数字弄没。
 *
 * 生产库只读查过（2026-08-29）：**目前还没有被踩到**（0 张孤儿子单、
 * 0 个父单被清零），所以这次修完不用清数据。
 *
 * ⚠️ 一份实现两处调用 —— 这个项目里「N 个入口只修了 M 个」已经犯过五六次。
 */

/** 卸一条柜内记录需要的信息（调用方先查好，因为两条路查的方式不一样） */
export interface UnloadableItem {
  id: string;
  shipment: {
    id: string;
    parentTrackingNo: string | null;
    packageCount: number | null;
    volumeM3: unknown;
    weightKg: unknown;
  };
}

const toNum = (v: unknown): number => (v == null ? 0 : Number(v));

export async function unloadItemFully(
  tx: any,
  item: UnloadableItem,
  companyId: string,
): Promise<{ 还给父单: boolean; 删了子单: boolean }> {
  await tx.shipmentContainerItem.delete({ where: { id: item.id } });

  /**
   * 没有父单 = 这票货是整票装进柜的（没分柜），子单就是它自己 ——
   * 那种情况不许删运单，只把柜内记录删掉就行。
   */
  if (!item.shipment.parentTrackingNo) {
    return { 还给父单: false, 删了子单: false };
  }

  // ⚠️ 锁序【... → 运单 → 父单】，跟别处一致
  await tx.$queryRaw`
    SELECT id FROM shipments
    WHERE tracking_no = ${item.shipment.parentTrackingNo} AND company_id = ${companyId}
    FOR UPDATE
  `;
  const parent = await tx.shipment.findFirst({
    where: { trackingNo: item.shipment.parentTrackingNo, companyId },
    select: { id: true, packageCount: true, volumeM3: true, weightKg: true, currentStatus: true },
  });

  if (parent) {
    /**
     * ⚠️ 子单马上要被删掉，它身上的**体积和重量必须先全部加回父单**，
     * 否则这两个数随子单一起消失（2026-08-22 修过一次）。
     */
    const childVol = toNum(item.shipment.volumeM3);
    const childWt = item.shipment.weightKg == null ? null : Number(item.shipment.weightKg);
    const pv = toNum(parent.volumeM3);
    const pw = parent.weightKg == null ? null : Number(parent.weightKg);
    const newPkg = (parent.packageCount ?? 0) + (item.shipment.packageCount ?? 0);

    /**
     * ⚠️⚠️ **状态也要退回来**（2026-08-29 补，这是另一个 bug）。
     *
     * 装柜时父单件数被扣到 0，于是它的状态跟着子单走
     * （parent-status.ts:132「父单自己没货了才接管它的状态」）。
     * 卸柜把件数还回去之后父单又「自己有货」了，那条规矩就不再接管它 ——
     * **父单的状态从此永远冻在卸柜之前那一刻**，再也没人会更新。
     *
     * 最坏的情况：一票货已经推到「已签收」，员工发现装错柜、卸下来，
     * 客户在订单里还是看到「已签收」，而货其实躺在仓库里。
     *
     * 所以这里明确把它退回「已创建」—— 货回到仓库、等着重新装柜，
     * 那正是流程里 `loaded`（已装柜）的前一站。
     * ⚠️ 只在**父单确实拿回了货**（newPkg > 0）且状态确实往前走过时才退，
     *    别把本来就没动过的父单也改一遍。
     */
    const 要退状态 = newPkg > 0 && parent.currentStatus !== "created";
    await tx.shipment.update({
      where: { id: parent.id },
      data: {
        packageCount: newPkg,
        volumeM3: Number((pv + childVol).toFixed(3)) as any,
        ...(pw == null || childWt == null ? {} : { weightKg: Number((pw + childWt).toFixed(2)) as any }),
        ...(要退状态 ? { currentStatus: "created" } : {}),
        updatedAt: new Date(),
      },
    });

    if (要退状态) {
      // 写一条轨迹，让客户看得懂「货为什么退回去了」，而不是状态莫名其妙变了
      await tx.statusLog.create({
        data: {
          id: `sl_unld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId,
          shipmentId: parent.id,
          operatorId: "system",
          operatorRole: "system",
          operatorName: "系统",
          fromStatus: parent.currentStatus,
          toStatus: "created",
          remark: "已从柜子卸下，退回仓库等待重新装柜",
          changedAt: new Date(),
        },
      });
    }
  }

  await tx.shipment.delete({ where: { id: item.shipment.id } });
  return { 还给父单: !!parent, 删了子单: true };
}

/**
 * 删整个柜子之前，把柜里每一条记录都卸下来。
 * ⚠️ 按 id 排序处理，跟别处的锁序规矩一致（同一批行的加锁顺序必须固定）。
 */
export async function unloadAllItemsOfContainer(
  tx: any,
  containerId: string,
  companyId: string,
): Promise<number> {
  const items = await tx.shipmentContainerItem.findMany({
    where: { containerId },
    select: {
      id: true,
      shipment: {
        select: { id: true, parentTrackingNo: true, packageCount: true, volumeM3: true, weightKg: true },
      },
    },
  });
  if (items.length === 0) return 0;
  const ordered = [...items].sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of ordered) {
    if (!it.shipment) {
      throw new BusinessError("柜内记录指向的运单不存在，请联系技术处理", 400, "VALIDATION_ERROR");
    }
    await unloadItemFully(tx, it as UnloadableItem, companyId);
  }
  return ordered.length;
}
