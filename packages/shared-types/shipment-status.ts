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
  | "deliveryBooked"
  // 2026-08-13：柜子到泰国仓卸货。原来这一步不写客户轨迹，客户看到的是
  // 「清关已放行」直接跳「已到仓」，中间几天一片空白。海运陆运都有。
  | "unloading";

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
  "unloading",
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
  "unloading",
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
/**
 * 「在途」= 已经装柜发走了、但还没签收的全部状态（2026-08-21 新增）。
 *
 * ⚠️ **从两条流程表自动推导，不要手写清单。**
 * 之前有两处各写了一份写死的名单，两份都出过错：
 *   ① 管理员看板数的是 `currentStatus === "inTransit"` —— 系统里**根本没有这个状态**，
 *      所以「在途订单」这个数字从上线起就一直是 0（生产实测：显示 0，实际 366 张）。
 *   ② AI 模块的 IN_TRANSIT_STATUSES 只列了海运，**漏掉全部 5 个陆运状态**
 *      （过境越南、老挝边境已放行等），问「在途多少」会少报陆运的货。
 * 自动推导之后，以后往流程里加环节这里会自己跟上。
 *
 * 口径按用户的业务说法（交接文档 1.5）：**装柜了 = 发走了**，所以从 loaded 起算；
 * 「已创建」「暂缓柜」还没发走不算在途，已签收/退回/取消也不算。
 */
const NOT_IN_TRANSIT: ShipmentStatus[] = [
  "created",
  "holdLoading",
  ...COMPLETED_STATUSES,
  ...SHIPMENT_EXCEPTION_STATUSES,
];

export const IN_TRANSIT_STATUSES: ShipmentStatus[] = Array.from(
  new Set([...SHIPMENT_STATUS_FLOW, ...SHIPMENT_STATUS_FLOW_LAND]),
).filter((s) => !NOT_IN_TRANSIT.includes(s));
