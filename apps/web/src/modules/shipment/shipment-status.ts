/* ==========================================================================
   运单状态 → 中文（三端唯一一份）
   ------------------------------------------------------------------------
   2026-08-07：客户端原来自己写了一份小的对照表，漏了 pickedUp、inWarehouseCN，
   客户在「物流状态」那一列直接看到英文单词。系统要求全中文，所以合并到这里。

   ⚠️ key 一律小写，查表前会 toLowerCase()。新加状态两件事：
      1. 在这里补一行；
      2. 如果它还要在轨迹弹窗里显示，去 ShipmentTrackModal.tsx 的 STATUS_CONFIG
         补一行颜色（那边只管颜色，中文从这里取）。
   ========================================================================== */

export const SHIPMENT_STATUS_ZH: Record<string, string> = {
  created: "已创建",
  pickedup: "已揽收",
  inwarehousecn: "国内仓已收货",
  receivedcn: "国内仓已收货",
  customspending: "报关中",
  holdloading: "暂缓柜",
  loaded: "已装柜",
  customsinspectcn: "国内海关查验",
  inspectclearedcn: "国内查验放行",
  delaydeparted: "延迟开船",
  delay_departed: "延迟开船",
  etaupdated: "到港时间更新",
  portclosed: "港口封港暂停作业",
  berthed: "已靠泊",
  departed: "已开船",
  customsinspectth: "泰国海关查验",
  inspectclearedth: "泰国查验放行",
  deliverybooked: "预约派送",
  delayintransit: "延迟运输",
  delay_in_transit: "延迟运输",
  arrivedport: "已到港",
  intransit: "运输中",
  // 陆运专属环节（2026-08-06）
  atportcn: "到达凭祥口岸",
  exportcleared: "出口已放行",
  invietnam: "过境越南",
  laoscleared: "老挝边境已放行",
  borderdelay: "口岸滞留",
  customsinspect: "海关查验",
  customsth: "清关中",
  customscleared: "清关已放行",
  inwarehouseth: "已到仓",
  warehouseth: "已到仓",
  outfordelivery: "派送中",
  delivered: "派送完成",
  exception: "异常",
  returned: "已退回",
  cancelled: "已取消",
  // 柜子状态（老轨迹里混进过柜子的状态值，一并认掉，免得漏出英文）
  customs: "清关中",
  loading: "装柜中",
  sealed: "已封柜",
  arrived: "已到港",
  unloading: "正在卸柜",
  in_warehouse_th: "已到仓",
  out_for_delivery: "派送中",
  signed: "已签收",
  // 2026-08-13 新增那 8 个的柜子写法（下划线），同理一并认掉
  hold_loading: "暂缓柜",
  customs_inspect_cn: "国内海关查验",
  inspect_cleared_cn: "国内查验放行",
  export_cleared: "出口已放行",
  eta_updated: "到港时间更新",
  port_closed: "港口封港暂停作业",
  customs_inspect_th: "泰国海关查验",
  inspect_cleared_th: "泰国查验放行",
  delivery_booked: "预约派送",
};

/**
 * 客户端对 delivered 一直叫「已签收」，员工端/轨迹叫「派送完成」。
 * 这次只补漏翻译，不改任何已有文案，所以把差异放在这里。
 */
export const CLIENT_STATUS_ZH_OVERRIDES: Record<string, string> = {
  delivered: "已签收",
};

/**
 * 状态转中文。查不到时返回「未知状态」而不是把英文原样吐给用户，
 * 同时在控制台留一条警告，方便发现是哪个状态漏配了。
 */
export function shipmentStatusZh(
  status: string | undefined | null,
  overrides?: Record<string, string>,
): string {
  if (!status) return "—";
  const key = status.trim().toLowerCase();
  if (!key) return "—";
  const zh = overrides?.[key] ?? SHIPMENT_STATUS_ZH[key];
  if (zh) return zh;
  if (typeof console !== "undefined") {
    console.warn(`[状态未翻译] 运单状态 "${status}" 没有中文对照，去 modules/shipment/shipment-status.ts 补一行`);
  }
  return "未知状态";
}
