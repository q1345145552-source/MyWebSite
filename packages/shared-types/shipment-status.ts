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
  | "atPortCn"
  | "inVietnam"
  | "laosCleared"
  | "borderDelay"
  // 越南口岸抽查（2026-08-13 确认口径）
  | "customsInspect"
  // ↓ 2026-08-13 新增。⚠️ exportCleared 从「陆运专属」变成**海运陆运都有**
  //   （用户：少数海运柜也走报关放行节点）。
  | "exportCleared"
  | "customsInspectCn"
  | "inspectClearedCn"
  // ↓ 海运专属
  | "holdLoading"
  | "etaUpdated"
  | "portClosed"
  | "berthed"
  | "customsInspectTh"
  | "inspectClearedTh"
  | "deliveryBooked";

/** 海运流程（原来的唯一流程，未改动） */
export const SHIPMENT_STATUS_FLOW: ShipmentStatus[] = [
  "created",
  "holdLoading",
  "loaded",
  "customsInspectCn",
  "inspectClearedCn",
  "exportCleared",
  "delayDeparted",
  "etaUpdated",
  "portClosed",
  "berthed",
  "departed",
  "delayInTransit",
  "arrivedPort",
  "customsInspectTh",
  "inspectClearedTh",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "deliveryBooked",
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
  "customsInspectCn",
  "inspectClearedCn",
  "atPortCn",
  "borderDelay",
  "exportCleared",
  "inVietnam",
  "customsInspect",
  "laosCleared",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];

/**
 * 只有陆运才会出现的状态，用来判断一票货该按哪条流程显示。
 *
 * ⚠️ 2026-08-13：exportCleared 从这份名单里**拿掉了** —— 海运少数柜也走出口已放行，
 *    留着会把走了这一步的海运货误判成陆运。
 */
export const LAND_ONLY_STATUSES: ShipmentStatus[] = [
  "atPortCn",
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