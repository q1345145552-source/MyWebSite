// 运单状态流转定义，从 shipments/routes.ts 提取为共享模块
// 避免多个文件各自定义导致不一致和未导入引用错误

// 海运流程。2026-08-13 按用户给的实际业务加进 8 个环节，
// 顺序必须和 containers/status-flow.ts 的 CONTAINER_STATUS_FLOW 一一对应。
//
// ⚠️「一一对应」说的是**按名字、按先后次序**对应（CONTAINER_TO_SHIPMENT_STATUS 那张
// 名字映射表；柜子推进按它推运单，运单侧靠 canTransitLoose 只认「往前」），
// **不是按下标**——全库查过，没有任何代码拿两张表的同一个下标互查。
// 所以 2026-09-02 在这里插 inWarehouseCN（柜子流程里没有对应环节，就像 created 一样）
// 不会让后面的环节错位；柜子那张表不用动。
export const STATUS_FLOW = [
  "created",
  // 2026-09-02 进主流程：货到国内仓（中文「已入库」）。老板拍板：员工建单=货已到仓，
  // 起始状态就是它；客户预报单仍从 created 起，仓库确认收货后推到这里。
  // 排在 holdLoading 前面 —— 「暂缓装柜」说的是已经在仓里的货。
  // ⚠️ 它跟延迟类一样是**可跳过的中间态**（见下面 SKIP_ON_ADVANCE_STATUSES）。
  "inWarehouseCN",
  // 仓库里暂时不装这个柜
  "holdLoading",
  "loaded",
  "customsInspectCn",
  "inspectClearedCn",
  "exportCleared",
  "delayDeparted",
  // 船期变了，重新给一个预计到港时间
  "etaUpdated",
  // 台风等原因装货港停止作业
  "portClosed",
  // 港口拥堵 / 泊位排队，船靠上码头
  "berthed",
  "departed",
  // 已开船但海上延误、还没到港。和 delayDeparted 是一对：一个是没准点开、一个是没准点到。
  "delayInTransit",
  "arrivedPort",
  "customsInspectTh",
  "inspectClearedTh",
  "customsTH",
  "customsCleared",
  // 2026-08-13：柜子到泰国仓卸货，原来这一步不写客户轨迹
  "unloading",
  "inWarehouseTH",
  // 跟客户约好上门时间，还没发车
  "deliveryBooked",
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
  // 2026-09-02 进主流程：货到国内仓（已入库），海运陆运都有
  "inWarehouseCN",
  "loaded",
  // 2026-08-13 新增：国内装柜后被海关拉去查验，海运陆运都可能
  "customsInspectCn",
  "inspectClearedCn",
  "atPortCn",
  // 堵在口岸出不去
  "borderDelay",
  "exportCleared",
  "inVietnam",
  // 2026-08-13 挪位：这个指的是越南口岸抽查，原来排在 laosCleared 后面
  "customsInspect",
  "laosCleared",
  // 2026-08-13 新增：泰国侧清关，少数陆运柜会走
  "customsTH",
  "customsCleared",
  // 2026-08-13：柜子到泰国仓卸货，原来这一步不写客户轨迹
  "unloading",
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

/**
 * 严格版推进（canTransit 的「一次一格」）里**可以跨过**的中间态（2026-09-02）。
 *
 * ⚠️ 说老实话：严格版 canTransit 当前**全仓库没有任何调用方**（真正在用的闸
 * 全是 canTransitLoose，只查往前不往后）。这套跳过规则是纯保险——万一哪天
 * 有人把严格版接上，老单不至于被「已入库」这格卡死。别把它当成在用的防线。
 *
 * = 延迟类 + inWarehouseCN。把「已入库」也标成可跳过，理由和延迟类同一个：
 * 生产上已有的老运单还停在 created（拍板：不回填），它们靠装柜/柜子推进走
 * canTransitLoose 不受影响，但凡是走严格版「一次一格」的路，不标可跳过的话
 * created → holdLoading / loaded 会被这格新插进来的状态卡死 ——
 * 老单子反而动不了。跳过只影响「能不能跨」，不影响它作为正常一步被推到。
 */
export const SKIP_ON_ADVANCE_STATUSES = new Set([...DELAY_STATUSES, "inWarehouseCN"]);

export const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

export const COMPLETED_STATUSES = new Set(["delivered", "returned", "cancelled"]);

export type ShipmentStatus = (typeof STATUS_FLOW)[number];
