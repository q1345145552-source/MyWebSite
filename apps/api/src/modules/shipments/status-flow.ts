// 运单状态流转定义，从 shipments/routes.ts 提取为共享模块
// 避免多个文件各自定义导致不一致和未导入引用错误

export const STATUS_FLOW = [
  "created",
  "loaded",
  "delayDeparted",
  "departed",
  // 已开船但海上延误、还没到港。和 delayDeparted 是一对：一个是没准点开、一个是没准点到。
  "delayInTransit",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
] as const;

/**
 * 陆运流程（2026-08-06）。走陆路口岸，没有「开船」「到港」。
 * ⚠️ 加了这条之后，`canTransitLoose` 必须两条流程都认 ——
 * 只改上面那条 STATUS_FLOW 的话，陆运柜推到「到达凭祥口岸」会被判成非法流转
 * （实测报「以下运单不允许从当前状态流转到 atPortCn」）。
 */
export const STATUS_FLOW_LAND = [
  "created",
  "loaded",
  "atPortCn",
  "exportCleared",
  "inVietnam",
  "laosCleared",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
] as const;

/**
 * 「延迟」类状态是可跳过的中间态。
 *
 * 状态推进的规则是「一次只能往前一格」。把 delayDeparted / delayInTransit 排进主流程后，
 * 如果不把它们标成可跳过，就会出现「已装柜」跳不到「已开船」、「已开船」跳不到「已到港」——
 * 没延误的单子反而卡住了。所以推进时允许跨过连续的延迟状态。
 */
export const DELAY_STATUSES = new Set(["delayDeparted", "delayInTransit"]);

export const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

export const COMPLETED_STATUSES = new Set(["delivered", "returned", "cancelled"]);

export type ShipmentStatus = (typeof STATUS_FLOW)[number];
