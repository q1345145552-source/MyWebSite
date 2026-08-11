// 柜子状态流程的**唯一定义处**（2026-08-06 从 containers/routes.ts 抽出来）。
//
// 为什么抽出来：装柜、改运输方式、随柜补记轨迹这几处都要用同一套流程和中文，
// 原来各文件各抄一份，今天就已经抄出两份柜子状态中文了 —— CLAUDE.md 第 20 条讲的就是这个坑。
// 以后加状态**只改这个文件**，前端 staff/container-loading/page.tsx 里那两份要跟着改。

/** 海运流程（原来的唯一流程，一个字没改） */
export const CONTAINER_STATUS_FLOW = [
  "LOADING",
  "SEALED",
  // DELAY_DEPARTED（延迟开船）原来排在 IN_TRANSIT 后面，位置是错的 ——
  // 「没准点开船」只可能发生在开船之前。2026-08-01 挪到 SEALED 和 IN_TRANSIT 中间。
  "DELAY_DEPARTED",
  "IN_TRANSIT",
  // 已经在海上了但延误、还没到港。和 DELAY_DEPARTED 是一对。
  "DELAY_IN_TRANSIT",
  "ARRIVED",
  "CUSTOMS",
  "CUSTOMS_CLEARED",
  "UNLOADING",
  "IN_WAREHOUSE_TH",
  "OUT_FOR_DELIVERY",
  "SIGNED",
] as const;

/**
 * 陆运流程（2026-08-06 新增）。
 *
 * 陆运走陆路口岸，**没有「开船」「到港」**，原来只有一条海运流程，陆运的货只能在
 * 「已开船」「已到港」上硬爬过去 —— 客户在轨迹里看到自己的陆运货「已开船」是错的，
 * 而且装柜到清关中间十几天一片空白。
 *
 * 环节照用户给的实际轨迹来（2026-08-06 他发的截图）：
 *   已装柜 → 到达凭祥口岸 → 出口已放行 → 过境越南 → 老挝边境已放行
 *        → 清关已放行 → 正在卸柜 → 已到仓 → 派送中 → 已签收
 *
 * ⚠️ 走哪条流程看柜子的 transportMode（2026-08-05 加的字段）。老柜子没标运输方式的
 *    一律按海运处理 —— 那是原来的行为，不会把已有的柜子带偏。
 */
export const CONTAINER_STATUS_FLOW_LAND = [
  "LOADING",
  "SEALED",
  "AT_PORT_CN",
  // 堵在口岸出不去 / 被海关拉去查验，都可跳过（不堵就直接推下一步）
  "BORDER_DELAY",
  "EXPORT_CLEARED",
  "IN_VIETNAM",
  "LAOS_CLEARED",
  "CUSTOMS_INSPECT",
  "CUSTOMS_CLEARED",
  "UNLOADING",
  "IN_WAREHOUSE_TH",
  "OUT_FOR_DELIVERY",
  "SIGNED",
] as const;

export const CONTAINER_STATUS_LABEL: Record<string, string> = {
  LOADING: "装柜中",
  SEALED: "已封柜",
  DELAY_DEPARTED: "延迟开船",
  IN_TRANSIT: "运输中",
  DELAY_IN_TRANSIT: "延迟运输",
  ARRIVED: "已到港",
  CUSTOMS: "清关中",
  CUSTOMS_CLEARED: "清关已放行",
  UNLOADING: "正在卸柜",
  IN_WAREHOUSE_TH: "已到仓",
  OUT_FOR_DELIVERY: "派送中",
  SIGNED: "已签收",
  // 陆运专属
  AT_PORT_CN: "到达凭祥口岸",
  EXPORT_CLEARED: "出口已放行",
  IN_VIETNAM: "过境越南",
  LAOS_CLEARED: "老挝边境已放行",
  BORDER_DELAY: "口岸滞留",
  CUSTOMS_INSPECT: "海关查验",
};

/**
 * 每个状态默认的「下一站」，客户在轨迹里能看到货接下来去哪。
 * 员工推进状态时可以手动改（改了以这次填的为准），不填就用这里的默认值。
 *
 * 口径：下一站写的是**下一个环节所在的地方**。
 *   陆运 已封柜 → 下一步是「到达凭祥口岸」→ 所以下一站是「广西凭祥出口」
 *   海运 运输中 → 下一步是「已到港」    → 所以下一站是「泰国港口」
 *
 * ⚠️ 2026-08-10 修：原来这里只有一张表、只按状态查，**没分海运陆运**。
 *    「已封柜」两条流程都有，而表里填的是陆运的走法，结果**海运柜推到已封柜，
 *    客户轨迹里被写成「下一站：广西凭祥出口」** —— 海运不走凭祥口岸。
 *    生产上实测已经写坏 12 个海运柜、67 条轨迹、35 张运单、14 个客户。
 *    所以拆成两张表，跟 CONTAINER_STATUS_FLOW / _LAND 一一对应。
 *    加新状态时**两张表都要想一遍这个状态属于哪条流程**。
 */
export const CONTAINER_NEXT_STOP_SEA: Record<string, string> = {
  // 已封柜之后就是开船，所以下一站是装船
  SEALED: "装船开船",
  IN_TRANSIT: "泰国港口",
  ARRIVED: "泰国清关",
  CUSTOMS_CLEARED: "泰国仓库",
};

export const CONTAINER_NEXT_STOP_LAND: Record<string, string> = {
  SEALED: "广西凭祥出口",
  AT_PORT_CN: "排队出关口",
  EXPORT_CLEARED: "过境越南",
  IN_VIETNAM: "老挝",
  LAOS_CLEARED: "泰国边境",
  BORDER_DELAY: "排队出关口",
  CUSTOMS_INSPECT: "泰国仓库",
  CUSTOMS_CLEARED: "泰国仓库",
};

/**
 * 这个柜子推到某个状态时，默认的下一站是什么。
 * 走哪张表和 flowOf 一个口径：陆运走陆运，其余（含没标运输方式的老柜子）走海运。
 */
export function nextStopOf(
  toStatus: string,
  transportMode: string | null | undefined,
): string | null {
  const table = transportMode === "land" ? CONTAINER_NEXT_STOP_LAND : CONTAINER_NEXT_STOP_SEA;
  return table[toStatus] ?? null;
}

/** 这个柜子该按哪条流程走：陆运走陆运，其余（含没标运输方式的老柜子）走海运 */
export function flowOf(transportMode: string | null | undefined): readonly string[] {
  return transportMode === "land" ? CONTAINER_STATUS_FLOW_LAND : CONTAINER_STATUS_FLOW;
}

/**
 * 「意外情况」类状态：滞留、查验、延迟。
 *
 * 这四个不是每票货都会经过的，**没有明确记录推过就绝不能假设它发生过** ——
 * 补记轨迹时凭空补一条「海关查验」，等于给客户编造了没发生过的事（2026-08-06 踩过）；
 * 撤销状态时往回退到这里，等于把柜子退回一个它从没到过的状态。
 *
 * 2026-08-10：原来这份名单抄在 loading-manifests/routes.ts 里，撤销那边要用第二份，
 * 所以挪到这个「唯一定义处」，两边共用。加新的意外状态只改这里。
 */
export const NEVER_GUESS_STATUSES: ReadonlySet<string> = new Set([
  "BORDER_DELAY",
  "CUSTOMS_INSPECT",
  "DELAY_DEPARTED",
  "DELAY_IN_TRANSIT",
]);

/** 柜子状态推进时，对应推运单到什么状态 */
export const CONTAINER_TO_SHIPMENT_STATUS: Record<string, string> = {
  // 陆运专属四步
  AT_PORT_CN: "atPortCn",
  EXPORT_CLEARED: "exportCleared",
  IN_VIETNAM: "inVietnam",
  LAOS_CLEARED: "laosCleared",
  BORDER_DELAY: "borderDelay",
  CUSTOMS_INSPECT: "customsInspect",
  SEALED: "loaded",
  DELAY_DEPARTED: "delayDeparted",
  IN_TRANSIT: "departed",
  DELAY_IN_TRANSIT: "delayInTransit",
  ARRIVED: "arrivedPort",
  CUSTOMS: "customsTH",
  CUSTOMS_CLEARED: "customsCleared",
  IN_WAREHOUSE_TH: "inWarehouseTH",
  OUT_FOR_DELIVERY: "outForDelivery",
  SIGNED: "delivered",
};
