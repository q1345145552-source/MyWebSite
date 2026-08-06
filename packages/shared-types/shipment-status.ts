export type ShipmentStatus =
  | "loaded"
  | "created"
  | "delayDeparted"
  | "departed"
  | "delayInTransit"
  | "arrivedPort"
  | "customsTH"
  | "customsCleared"
  | "inWarehouseTH"
  | "outForDelivery"
  | "delivered"
  | "exception"
  | "returned"
  | "cancelled"
  // ↓ 2026-08-06 新增：陆运专属环节（凭祥口岸 → 越南 → 老挝 → 泰国）。
  //   海运的货永远不会走到这几个状态，两条流程互不干扰。
  | "atPortCn"
  | "exportCleared"
  | "inVietnam"
  | "laosCleared"
  // 陆运的两个「卡住了」状态，可跳过（不堵关就直接跳过去）
  | "borderDelay"
  | "customsInspect";

/** 海运流程（原来的唯一流程，未改动） */
export const SHIPMENT_STATUS_FLOW: ShipmentStatus[] = [
  "created",
  "loaded",
  "delayDeparted",
  "departed",
  "delayInTransit",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];

/**
 * 陆运流程（2026-08-06 新增）。走陆路口岸，没有「开船」「到港」这两步。
 * 环节照用户提供的实际轨迹：
 *   已装柜 → 到达凭祥口岸 → 出口已放行 → 过境越南 → 老挝边境已放行
 *        → 清关已放行 → 已到仓 → 派送中 → 已签收
 */
export const SHIPMENT_STATUS_FLOW_LAND: ShipmentStatus[] = [
  "created",
  "loaded",
  "atPortCn",
  "borderDelay",
  "exportCleared",
  "inVietnam",
  "laosCleared",
  "customsInspect",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];

/** 只有陆运才会出现的状态，用来判断一票货该按哪条流程显示 */
export const LAND_ONLY_STATUSES: ShipmentStatus[] = [
  "atPortCn",
  "exportCleared",
  "inVietnam",
  "laosCleared",
  "borderDelay",
  "customsInspect",
];

export const SHIPMENT_EXCEPTION_STATUSES: ShipmentStatus[] = [
  "exception",
  "returned",
  "cancelled",
];
export const COMPLETED_STATUSES: ShipmentStatus[] = [
  "delivered",
  "returned",
  "cancelled",
];