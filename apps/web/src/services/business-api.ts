import { authHeaders, apiBaseUrl, parseApiResponse, apiRequest } from "./core-api";

export interface StaffCreateOrderPayload {
  clientId: string;
  warehouseId: string;
  batchNo?: string;
  trackingNo?: string;
  arrivedAt: string;
  itemName: string;
  productQuantity?: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
  cargoType?: string;
  receiverNameTh?: string;
  receiverPhoneTh?: string;
  receiverAddressTh?: string;
  products?: Array<{
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
  remark?: string;
}

export interface ClientPrealertPayload {
  warehouseId: string;
  itemName?: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
  receiverNameTh?: string;
  receiverPhoneTh?: string;
  receiverAddressTh?: string;
  trackingNo?: string;
  products?: Array<{
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    weightKg?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
}

export interface ClientAddressItem {
  id: string;
  companyId: string;
  clientId: string;
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  lat?: number;
  lng?: number;
  label?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UniversalExpressTrackResult {
  trackingNo: string;
  companyCode: string;
  statusCode: string;
  statusText: string;
  events: Array<{
    time: string;
    content: string;
  }>;
}

/**
 * ⚠️ 这个类型必须和后端 /client/wallet/overview 的返回**逐字对齐**
 * （apps/api/src/modules/client-compliance/routes.ts）。
 *
 * 2026-08-07 教训：这里原来还声明着 `exchangeRate: { pair, rate, updatedAt }`，
 * 但后端在集货余额改造时早就不返回它了。TypeScript 只信这里写的，不会去核对后端，
 * 所以类型检查和构建全绿，客户一打开首页却报
 * 「Cannot read properties of undefined (reading 'rate')」。
 * 改后端返回结构时，务必回来同步这里。
 */
export interface ClientWalletOverview {
  balance: number;
  currency: string;
  updatedAt: string | null;
  accounts: Array<{
    currency: string;
    balance: number;
    updatedAt: string;
  }>;
}

// ===== 充值相关类型 =====

export interface WalletRechargeItem {
  id: string;
  currency: string;
  amount: number;
  paymentMethod: string;
  status: string; // PENDING | APPROVED | REJECTED
  remark: string | null;
  reviewRemark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWalletRechargeItem {
  id: string;
  clientId: string;
  clientName: string;
  companyName: string | null;
  currency: string;
  amount: number;
  paymentMethod: string;
  proofImage: string;
  status: string;
  remark: string | null;
  reviewRemark: string | null;
  reviewedBy: string | null;
  reviewerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffWalletBalanceItem {
  clientId: string;
  clientName: string;
  companyName: string | null;
  cny: number;
  thb: number;
}

export interface OrderProductImageItem {
  id: string;
  fileName: string;
  mime: string;
  contentBase64?: string;
  filePath?: string | null;
  imageUrl?: string;
  createdAt: string;
}

export interface ShipmentItem {
  id: string;
  orderId?: string;
  orderNo?: string;
  trackingNo: string;
  parentTrackingNo?: string;
  batchNo?: string;
  containerNo?: string;
  cargoType?: string;
  clientId?: string;
  clientName?: string;
  itemName?: string;
  domesticTrackingNo?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  totalPackageCount?: number;
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  arrivedAt?: string;
  currentStatus: string;
  currentLocation?: string;
  updatedAt?: string;
  warehouseId?: string;
  remark?: string | null;
  transportMode?: string;
  shipDate?: string;
  receiverAddressTh?: string;
  receivableAmountCny?: number;
  receivableCurrency?: string;
  paymentStatus?: "paid" | "unpaid";
  canEdit?: boolean;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

export interface OrderProductItem {
  id: string;
  itemName: string;
  packageCount: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  productQuantity?: number | null;
  cargoType?: string;
  domesticTrackingNo?: string;
  weightKg?: number | null;
}

export interface StaffInboundPhotoItem {
  id: string;
  shipmentId: string;
  operatorId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  note?: string;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  orderNo?: string;
  clientId?: string;
  clientName?: string;
  warehouseId?: string;
  remark?: string | null;
  batchNo?: string;
  latestRemark?: string;
  logisticsRecords?: Array<{
    remark: string;
    changedAt: string;
    fromStatus?: string;
    toStatus?: string;
    operatorRole?: string;
    operatorName?: string;
  }>;
  itemName: string;
  transportMode: string;
  cargoType?: string;
  approvalStatus?: "pending" | "approved" | "shipped" | "received";
  domesticTrackingNo?: string;
  trackingNo?: string;
  currentStatus?: string;
  statusGroup?: "unfinished" | "completed";
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg?: number;
  volumeM3?: number;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  paidAt?: string;
  paidBy?: string;
  paymentProofUploadedAt?: string;
  shipDate?: string;
  createdAt: string;
  updatedAt?: string;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

/**
 * ⚠️ 必须和后端 /admin/dashboard/overview 的返回逐字对齐
 * （apps/api/src/modules/admin/routes.ts）。这里写了后端没有的字段，
 * TypeScript 不会报错，页面上却会读到 undefined —— 2026-08-07 客户端就这么崩过一次。
 */
export interface AdminOverview {
  staffAccountCount: number;
  clientAccountCount: number;
  newOrderCountToday: number;
  inTransitOrderCount: number;
  receivedVolumeM3Today: number;
  /**
   * 柜子分段统计（2026-08-07 新增，取代前端按柜号去重的老算法）。
   * 四段相加 = containerTotalCount，后端用减法保证不漏任何状态。
   */
  containerLoadingCount: number;
  containerOnTheWayCount: number;
  containerAtWarehouseCount: number;
  containerDoneCount: number;
  containerTotalCount: number;
}

export interface AdminUserItem {
  id: string;
  companyId: string;
  role: string;
  name: string;
  phone: string;
  status: string;
  createdAt: string;
  companyName?: string;
  email?: string;
}

export interface AdminOrderItem {
  id: string;
  orderId?: string;
  shipmentId?: string;
  cargoType?: string;
  clientId: string;
  clientName: string | null;
  warehouseId: string;
  orderNo: string | null;
  itemName: string;
  transportMode: string;
  domesticTrackingNo: string | null;
  batchNo: string | null;
  approvalStatus: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg: number | null;
  volumeM3: number | null;
  receiverAddressTh?: string;
  containerNo?: string;
  remark?: string | null;
  trackingNo?: string;
  currentStatus?: string;
  canEdit?: boolean;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  shipDate: string | null;
  statusGroup?: string;
  createdAt: string;
  updatedAt: string;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

export interface AdminAiSessionMemoryItem {
  key: string;
  companyId: string;
  userId: string;
  sessionId: string;
  intent?: string;
  itemName?: string;
  statusScope?: string;
  timeHint?: string;
  metric?: string;
  updatedAt: string;
}

export interface AdminAiKnowledgeGapItem {
  id: string;
  companyId: string;
  userId: string;
  sessionId?: string;
  question: string;
  answerSummary: string;
  knowledgeCountAtAsk: number;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface AdminLmpRateItem {
  id: string;
  routeCode: string;
  supplierName: string;
  transportMode: string;
  seasonTag: string;
  supplierCost: number;
  quotePrice: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  updatedAt: string;
}

export interface AdminCustomsCaseItem {
  id: string;
  shipmentId?: string;
  orderId?: string;
  status: string;
  remark?: string;
  updatedAt: string;
}

export interface AdminLastmileItem {
  id: string;
  deliveryNo: string;
  shipmentId: string;
  carrierName: string;
  externalTrackingNo: string;
  driverName?: string | null;
  licensePlate?: string | null;
  phoneNumber?: string | null;
  status: string;
  updatedAt: string;
}

export interface AdminSettlementEntryItem {
  id: string;
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  currency: string;
  updatedAt: string;
}

export interface AdminProfitItem {
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  profit: number;
  currency: string;
  updatedAt: string;
}

export interface AdminOpsOverview {
  profitSummary: {
    totalRevenue: number;
    totalCost: number;
    totalProfit: number;
    grossMarginPercent: number;
  };
  profitTrend: Array<{
    orderId: string;
    profit: number;
    updatedAt: string;
  }>;
  customsAlerts: Array<{
    id: string;
    shipmentId?: string;
    orderId?: string;
    status: string;
    remark?: string;
    updatedAt: string;
  }>;
  supplierPriceAlerts: Array<{
    routeCode: string;
    supplierName: string;
    previousQuotePrice: number;
    latestQuotePrice: number;
    delta: number;
    updatedAt: string;
  }>;
}

export interface FinanceRow {
  id: string;
  orderNo: string;
  clientName: string;
  transportMode: string;
  warehouse: string;
  weightKg: number;
  volumeM3: number;
  paymentStatus: string;
  createdAt: string;
}

export interface FinanceSummary {
  totalOrders: number;
  totalWeight: number;
  totalVolume: number;
  monthOrders: number;
  rows: FinanceRow[];
}

export async function createStaffOrder(payload: StaffCreateOrderPayload): Promise<{
  orderId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 员工上传订单详情产品图（单订单最多 5 张）。
 */
export async function uploadStaffOrderProductImage(payload: {
  orderId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
}): Promise<{ id: string; orderId: string; fileName: string; mime: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/product-images`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 员工删除订单详情产品图。
 */
export async function deleteStaffOrderProductImage(id: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/product-images?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function createClientPrealert(payload: ClientPrealertPayload): Promise<{
  prealertId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 拉取客户端地址簿。
 */
export async function fetchClientAddresses(): Promise<ClientAddressItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ClientAddressItem[] }>(response);
  return data.items;
}

/**
 * 新增客户端地址。
 */
export async function createClientAddress(payload: {
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  lat?: number;
  lng?: number;
  label?: string;
  isDefault?: boolean;
}): Promise<ClientAddressItem> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 设置默认地址。
 */
export async function setDefaultClientAddress(id: string): Promise<{ id: string; isDefault: true; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses/set-default`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ id }),
  });
  return parseApiResponse(response);
}

/**
 * 删除客户端地址。
 */
export async function deleteClientAddress(id: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 通用快递查询（快递100代理）。
 */
export async function fetchUniversalExpressTrack(params: {
  trackingNo: string;
  companyCode?: string;
}): Promise<UniversalExpressTrackResult> {
  const query = new URLSearchParams();
  query.set("trackingNo", params.trackingNo);
  if (params.companyCode?.trim()) {
    query.set("companyCode", params.companyCode.trim());
  }
  const response = await fetch(`${apiBaseUrl()}/client/express/universal?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 获取多币种账户概览与汇率。
 */
export async function fetchClientWalletOverview(): Promise<ClientWalletOverview> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

// ===== 客户端充值 =====

/**
 * 客户端提交充值申请。
 */
export async function submitRecharge(payload: {
  amount: number;
  /** 2026-08-07 起集货余额只有人民币，后端强制按 CNY 入账，这里不用再传 */
  paymentMethod: string;
  proofImage: string;
  remark?: string;
}): Promise<{ id: string; status: string; message: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/recharge`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/** 集货余额流水一行（2026-08-07 新增） */
export interface ConsolidationLedgerItem {
  id: string;
  type: string;
  typeLabel: string;
  /** 正数进账、负数出账 */
  amount: number;
  balanceAfter: number;
  source: string;
  refNo: string;
  remark: string;
  createdAt: string;
}

/**
 * 客户端获取集货余额流水（充值到账 / 集货付款 / 撤销退款）。
 */
export async function fetchConsolidationLedger(): Promise<{ items: ConsolidationLedgerItem[]; total: number }> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/ledger`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 客户端获取充值记录。
 */
export async function fetchClientWalletRecharges(): Promise<{ recharges: WalletRechargeItem[] }> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/recharges`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

// ===== 管理员充值审核 =====

/**
 * 管理员获取充值审核列表。
 */
export async function fetchAdminRecharges(status?: string): Promise<{ recharges: AdminWalletRechargeItem[] }> {
  const query = status ? `?status=${status}` : "";
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges${query}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 管理员通过充值申请。
 */
export async function approveRecharge(id: string): Promise<{ approved: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges/approve`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return parseApiResponse(response);
}

/**
 * 管理员拒绝充值申请。
 */
export async function rejectRecharge(id: string, reviewRemark: string): Promise<{ rejected: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges/reject`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id, reviewRemark }),
  });
  return parseApiResponse(response);
}

// ===== 员工端客户余额 =====

/**
 * 员工端获取所有客户余额。
 */
export async function fetchStaffWalletBalances(): Promise<{ balances: StaffWalletBalanceItem[] }> {
  const response = await fetch(`${apiBaseUrl()}/staff/wallet/balances`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchClientOrders(params?: {
  statusGroup?: "completed" | "unfinished";
}): Promise<OrderItem[]> {
  const query = new URLSearchParams();
  query.set("pageSize", "500");
  query.set("page", "1");
  if (params?.statusGroup) query.set("statusGroup", params.statusGroup);
  const response = await fetch(`${apiBaseUrl()}/client/orders?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

/**
 * 获取客户端预报单列表
 * @param status 预报单状态：pending(待审核), approved(已审核/待发货), shipped(已发货), all(全部)
 */
export async function fetchClientPrealerts(status: string = "pending"): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts?status=${status}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

/**
 * 客户确认发货 - 将已审核的预报单转为正式订单
 */

export async function deleteClientPrealert(orderId: string): Promise<{ deleted: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ orderId }),
  });
  return parseApiResponse(response);
}

export async function updateClientPrealert(orderId: string, payload: Record<string, unknown>): Promise<{ updated: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ orderId, ...payload }),
  });
  return parseApiResponse(response);
}

export async function fetchStaffPrealerts(): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function receiveStaffPrealert(payload: {
  orderId: string;
  itemName?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode?: "sea" | "land";
  cargoType?: string;
}): Promise<{ orderId: string; status: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}




export async function fetchClientShipments(): Promise<ShipmentItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/shipments/search`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ShipmentItem[] }>(response);
  return data.items;
}

export async function splitStaffShipment(payload: {
  parentShipmentId: string;
  splits: Array<{ trackingNo: string; batchNo: string; itemName: string; packageCount: number }>;
}): Promise<{ parentTrackingNo: string; children: Array<{ trackingNo: string; shipmentId: string }> }> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/* ==========================================================================
   按 total 翻页拿完，不要只拿第一页（2026-08-10）
   --------------------------------------------------------------------------
   原来这里写死 `pageSize=500&page=1`，只拿第一页。生产上运单已经 663 条，
   **第 501 条往后的 163 条在页面上等于不存在** —— 而且搜索是在已拿回来的
   那批里用 useMemo 筛的，所以那些老运单不管怎么搜都搜不到（用户实测
   搜 YW0001276 显示「暂无匹配订单」，但它在库里好好的）。

   这跟 CLAUDE.md 第 19 条是同一个坑（尾端派送丢货）：
   **前端筛只对「已经全拿到」的数据成立。要拿全就得按 total 翻页拿完。**
   ========================================================================== */
const PAGE_SIZE = 500;
/** 安全上限：50 页 = 25000 条。到顶了在控制台喊一声，别再像以前那样静默截断 */
const MAX_PAGES = 50;

async function fetchAllPages<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const response = await fetch(`${apiBaseUrl()}${path}${sep}pageSize=${PAGE_SIZE}&page=${page}`, {
      method: "GET",
      headers: { ...authHeaders() },
    });
    const data = await parseApiResponse<{ items: T[]; total?: number }>(response);
    const items = data.items ?? [];
    all.push(...items);
    // 后端给了 total 就按 total 判断拿完没有；没给就看这一页是不是没装满
    const done = typeof data.total === "number" ? all.length >= data.total : items.length < PAGE_SIZE;
    if (done) return all;
    if (page === MAX_PAGES) {
      console.warn(`[列表没拿全] ${path} 已拿 ${all.length} 条，到了 ${MAX_PAGES} 页上限还没拿完，请改用后端搜索`);
    }
  }
  return all;
}

export async function fetchStaffShipments(): Promise<ShipmentItem[]> {
  return fetchAllPages<ShipmentItem>("/staff/shipments");
}

/** 运单列表顶部那排数字（A3 方案 §3.2）。三端同一套字段，口径一致。
 *  ⚠️ 必须和后端 countShipmentOverview() 的返回逐字对齐 —— TypeScript 不会替你核对。 */
export interface StaffShipmentOverview {
  /** 在途：已经发出、还没到泰国仓 */
  inTransitCount: number;
  /** 延迟 · 查验：延迟开船 / 海上延误 / 口岸滞留 / 海关查验 / 异常 */
  attentionCount: number;
  /** 已到仓待派送 */
  atWarehouseCount: number;
  /** 本月已签收 */
  signedThisMonthCount: number;
  /** 下面几个是后端返回的对账字段，界面不显示 */
  totalCount: number;
  createdCount: number;
  deliveringCount: number;
  doneCount: number;
}

/** 员工端和管理员端共用这个接口（后端 requireRole 里就允许这两个角色） */
export async function fetchStaffShipmentOverview(): Promise<StaffShipmentOverview> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse<StaffShipmentOverview>(response);
}

/** 客户端只数自己的运单，所以是另一个接口，返回结构完全一样 */
export async function fetchClientShipmentOverview(): Promise<StaffShipmentOverview> {
  const response = await fetch(`${apiBaseUrl()}/client/shipments/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse<StaffShipmentOverview>(response);
}


/**
 * 尾端派送能挑的运单状态：已到仓 / 预约派送 / 派送中 / 已签收
 *
 * ⚠️ 2026-08-13 补上 deliveryBooked（预约派送）。加这个状态时漏了这里，
 *    结果是**推到「预约派送」的货在尾端派送页面上直接消失**，员工找不到就发不出去。
 *    跟 2026-08-06「445 张运单选不到」是同一个坑：状态清单写死在好几处，加状态要全找一遍。
 */
const LASTMILE_STATUSES = "inWarehouseTH,deliveryBooked,outForDelivery,delivered";

export interface LastmileShipmentItem {
  id: string;
  trackingNo: string;
  clientId: string;
  itemName: string;
  packageCount: number;
  containerNo?: string;
}

/**
 * 拉取尾端派送可选的全部运单。
 *
 * ⚠️ 2026-08-06 修的一个真丢货的 bug：
 * 原来 staff 和 admin 两个页面各自写 `/staff/shipments?pageSize=500&all=1`，
 * 拿回「按更新时间倒序的前 500 条（所有状态混在一起）」再在前端筛这三种状态。
 * 生产实测：能派送的运单 571 张，但排进前 500 的只有 126 张 —— **445 张、5791 件货
 * 页面上根本选不到**，粘贴运单号批量勾选时这些号码会被静默丢弃，员工以为加进去了。
 *
 * 现在：① 让后端按状态筛（新增 status 参数）；② 按 total 翻页拿完，不止第 1 页。
 * 两个页面都改成调这个函数，别再各写各的。
 */
export async function fetchLastmileShipments(): Promise<LastmileShipmentItem[]> {
  const pageSize = 500;
  const collected: any[] = [];
  let page = 1;
  let total = 0;
  // 最多翻 20 页兜底，防止 total 异常时死循环
  while (page <= 20) {
    const url = `${apiBaseUrl()}/staff/shipments?pageSize=${pageSize}&page=${page}&all=1&status=${encodeURIComponent(LASTMILE_STATUSES)}`;
    const response = await fetch(url, { method: "GET", headers: { ...authHeaders() } });
    const data = await parseApiResponse<{ items: any[]; total?: number }>(response);
    const items = data.items ?? [];
    collected.push(...items);
    total = data.total ?? collected.length;
    if (items.length === 0 || collected.length >= total) break;
    page += 1;
  }
  return collected.map((s) => ({
    id: s.id,
    trackingNo: s.trackingNo,
    clientId: s.clientId ?? "",
    itemName: s.itemName ?? "",
    packageCount: s.packageCount ?? 0,
    containerNo: s.containerNo || undefined,
  }));
}

export async function fetchShipmentImages(orderId: string): Promise<OrderProductImageItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/images?orderId=${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ images: OrderProductImageItem[] }>(response);
  return data.images;
}

export async function fetchStaffClients(): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(`${apiBaseUrl()}/staff/clients`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: Array<{ id: string; name: string }> }>(response);
  return data.items;
}

/** 修复运单-订单关联接口的返回结果。 */
export type RepairStaffShipmentOrderLinksResult = {
  ok: boolean;
  repairedCount: number;
  repairedShipmentIds: string[];
  skipped: Array<{ shipmentId: string; reason: string }>;
};

/**
 * 请求后端修复运单与订单脱节（补建缺失订单并写回 order_id）。
 * @param payload.shipmentId 仅修复该运单，便于列表页定向处理。
 */
export async function repairStaffShipmentOrderLinks(
  payload?: { shipmentId?: string },
): Promise<RepairStaffShipmentOrderLinksResult> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/repair-order-links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload ?? {}),
  });
  return parseApiResponse(response);
}

/**
 * 为运单设置装柜号（Container No.）。
 */
export async function setStaffShipmentContainer(payload: {
  shipmentId: string;
  containerNo: string;
}): Promise<{ shipmentId: string; containerNo: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/set-container`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 上传入库拍照记录。
 */
export async function uploadStaffInboundPhoto(payload: {
  shipmentId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  note?: string;
}): Promise<{ id: string; shipmentId: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/inbound-photos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 查询指定运单的入库拍照记录。
 */
export async function fetchStaffInboundPhotos(shipmentId: string): Promise<StaffInboundPhotoItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/inbound-photos?shipmentId=${encodeURIComponent(shipmentId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: StaffInboundPhotoItem[] }>(response);
  return data.items;
}

/**
 * 员工端：按运单保存关联订单与运单的基础信息（运单列表展开区「订单详情」）。
 */
export async function patchStaffShipmentOrderBundle(payload: {
  shipmentId: string;
  trackingNo: string;
  batchNo?: string | null;
  itemName: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number | null;
  volumeM3?: number | null;
  domesticTrackingNo?: string | null;
  orderCreatedDate: string;
  transportMode: "sea" | "land";
  shipDate?: string | null;
  receiverAddressTh: string;
  containerNo?: string | null;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  warehouseId?: string;
  remark?: string | null;
}): Promise<{ shipmentId: string; orderId: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/patch-shipment-bundle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/dashboard/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchAdminStaff(): Promise<AdminUserItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/users?role=staff`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminUserItem[] }>(response);
  return data.items;
}

export async function fetchAdminClients(): Promise<AdminUserItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/users?role=client`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminUserItem[] }>(response);
  return data.items;
}

/** 同 fetchStaffShipments：按 total 翻页拿完，别只拿第一页（见那边的注释） */
export async function fetchAdminOrders(): Promise<AdminOrderItem[]> {
  return fetchAllPages<AdminOrderItem>("/admin/orders");
}

/**
 * 管理员更新客户端订单基础信息。
 */
export async function updateAdminOrder(payload: {
  orderId: string;
  // 除 orderId 外全部可选：只传本次改动过的项，没传的后端不会去动
  clientId?: string;
  itemName?: string;
  cargoType?: string;
  transportMode?: "sea" | "land";
  domesticTrackingNo?: string;
  trackingNo?: string;
  batchNo?: string;
  warehouseId?: string;
  remark?: string | null;
  receiverAddressTh?: string;
  containerNo?: string;
  productQuantity?: number;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  weightKg?: number | null;
  volumeM3?: number | null;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  shipDate?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行 */
    id?: string;
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
    weightKg?: number;
  }>;
}): Promise<{ orderId: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/orders/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function createAdminStaff(payload: {
  id?: string;
  name: string;
  phone: string;
  password?: string;
}): Promise<{ id: string; name: string; phone: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

// deleteAdminStaff() 已删除（2026-08-07）。
// 账号不再支持删除，改用 toggleUserBan() 封禁：账号登不进来，但单据、图片、余额全留着。
// 原因：数据库有 15 张表以 RESTRICT 认着账号，名下有任何一条记录就删不掉；
// 而且这个函数删员工时漏传管理员密码，后端第一关就打回，从来没成功过。
// 后端 DELETE /admin/users 也已停用。


export async function deleteAdminOrder(orderId: string): Promise<{ deleted: boolean; orderId: string; itemName: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/orders/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ orderId }),
  });
  return parseApiResponse(response);
}

export async function setAdminStaffPassword(userId: string, password: string): Promise<{ updated: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id: userId, password }),
  });
  return parseApiResponse(response);
}

export async function createAdminClient(payload: {
  id?: string;
  name: string;
  companyName?: string;
  phone: string;
  email?: string;
  password?: string;
}): Promise<{ id: string; name: string; companyName: string | null; phone: string; email: string | null; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function updateAdminClient(payload: {
  id: string;
  name?: string;
  companyName?: string;
  phone?: string;
  email?: string;
  password?: string;
}): Promise<{ id: string; name: string; companyName: string | null; phone: string; email: string | null; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/client/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminAiSessionMemory(params?: {
  limit?: number;
}): Promise<{ items: AdminAiSessionMemoryItem[]; total: number; limit: number }> {
  const query = new URLSearchParams();
  if (typeof params?.limit === "number") query.set("limit", String(params.limit));
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/session-memory${suffix ? `?${suffix}` : ""}`,
    {
      method: "GET",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function clearAdminAiSessionMemory(params?: {
  sessionId?: string;
  userId?: string;
}): Promise<{ removed: number; companyId: string; sessionId: string | null; userId: string | null }> {
  const query = new URLSearchParams();
  if (params?.sessionId) query.set("sessionId", params.sessionId);
  if (params?.userId) query.set("userId", params.userId);
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/session-memory${suffix ? `?${suffix}` : ""}`,
    {
      method: "DELETE",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function fetchAdminAiKnowledgeGaps(params?: {
  status?: "open" | "resolved";
}): Promise<{ items: AdminAiKnowledgeGapItem[]; total: number; status: "open" | "resolved" | "all" }> {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/knowledge-gaps${suffix ? `?${suffix}` : ""}`,
    {
      method: "GET",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function resolveAdminAiKnowledgeGap(params: {
  id: string;
}): Promise<{ resolved: true; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge-gaps/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  return parseApiResponse(response);
}

/**
 * 获取管理员渠道底价与报价列表。
 */
export async function fetchAdminLmpRates(): Promise<AdminLmpRateItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/lmp/rates`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminLmpRateItem[] }>(response);
  return data.items;
}

/**
 * 新增渠道底价与报价规则。
 */
export async function createAdminLmpRate(payload: {
  routeCode: string;
  supplierName: string;
  transportMode: string;
  seasonTag: string;
  supplierCost: number;
  quotePrice: number;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/lmp/rates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取关务监控列表。
 */
export async function fetchAdminCustomsCases(): Promise<AdminCustomsCaseItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/customs/cases`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminCustomsCaseItem[] }>(response);
  return data.items;
}

/**
 * 新增关务状态记录。
 */
export async function createAdminCustomsCase(payload: {
  shipmentId?: string;
  orderId?: string;
  status: string;
  remark?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/customs/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取末端派送单号集成列表。
 */
export async function fetchAdminLastmileOrders(): Promise<AdminLastmileItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminLastmileItem[] }>(response);
  return data.items;
}

/**
 * 新增末端派送对接记录。
 */
export async function createAdminLastmileOrder(payload: {
  shipmentIds: string[];
  driverName?: string;
  licensePlate?: string;
  phoneNumber?: string;
  status?: string;
}): Promise<{ deliveryNo: string; count: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取财务结算录入项。
 */
export async function fetchAdminSettlementEntries(): Promise<AdminSettlementEntryItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/entries`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminSettlementEntryItem[] }>(response);
  return data.items;
}

/**
 * 新增财务结算录入项（AR/AP/Tax）。
 */
export async function createAdminSettlementEntry(payload: {
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  currency?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取利润分析列表。
 */
export async function fetchAdminProfitAnalysis(): Promise<AdminProfitItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/profit`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminProfitItem[] }>(response);
  return data.items;
}

/**
 * 获取管理员运营总控看板数据（毛利/关务预警/报价变动）。
 */
export async function fetchAdminOpsOverview(): Promise<AdminOpsOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/ops/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 获取财务汇总数据。
 */
export async function fetchFinanceSummary(): Promise<FinanceSummary> {
  const response = await fetch(`${apiBaseUrl()}/admin/finance/summary`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

// ============================================================================
// 用户管理相关（管理员端）
// ============================================================================

// ManagedUser / fetchManagedUsers / createManagedUser / resetUserPassword 已删除（2026-08-07）。
// 它们只服务于「账号管理」页，而那个页面和「员工管理」「客户管理」是同一套功能、
// 调的还是同一批接口（/admin/users、/admin/users/set-password、toggle-ban），
// 用户要求砍掉重复入口，页面已删。
// 员工/客户列表用 fetchAdminStaff / fetchAdminClients，改密码用 setAdminStaffPassword。

/**
 * 禁用/启用用户（管理员）。
 */
export async function toggleUserBan(userId: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/toggle-ban`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ id: userId }),
  });
  return parseApiResponse(response);
}

// ============================================================================
// 装柜清单相关
// ============================================================================

export interface LoadingManifestItem {
  id: string;
  manifestNo: string;
  warehouse: string;
  status: string;
  /** sea = 海运 | land = 陆运 | null = 2026-08-05 之前建的老柜子，还没标 */
  transportMode: string | null;
  carrierInfo: string | null;
  sealedAt: string | null;
  totalBills: number;
  createdAt: string;
}

export interface LoadingManifestDetail extends LoadingManifestItem {
  bills: Array<{
    id: string;
    shipmentId: string;
    trackingNo: string | null;
    batchNo: string | null;
    itemName: string | null;
    clientId: string | null;
    productQuantity: number | null;
    cargoType: string | null;
    packageCount: number | null;
    transportMode: string | null;
    currentStatus: string | null;
    parentTrackingNo: string | null;
    loadedPieces: number;
    loadedVolume: number;
  }>;
}

/**
 * 创建装柜清单。
 */
export async function createLoadingManifest(payload: {
  warehouse: string;
  /** 必填，后端只认 sea / land，不传会 400 */
  transportMode: string;
  carrierInfo?: string;
  containerNo?: string;
}): Promise<{ manifestNo: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  const body = await parseApiResponse<{ message: string; manifest: { id: string; manifestNo: string } }>(response);
  return { manifestNo: body.manifest.manifestNo };
}

/**
 * 获取装柜清单列表。
 */
export async function fetchLoadingManifests(filters?: { query?: string; trackingNo?: string; status?: string; transportMode?: string }): Promise<LoadingManifestItem[]> {
  const params = new URLSearchParams();
  if (filters?.query) params.set("query", filters.query);
  if (filters?.trackingNo) params.set("trackingNo", filters.trackingNo);
  if (filters?.status) params.set("status", filters.status);
  // sea / land / none（none = 只看还没标运输方式的老柜子）
  if (filters?.transportMode) params.set("transportMode", filters.transportMode);
  const qs = params.toString();
  const url = `${apiBaseUrl()}/staff/loading-manifests${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: LoadingManifestItem[] }>(response);
  return data.items;
}

/**
 * 改柜子的运输方式（给「未标注」的老柜子补上；状态已经走到某一方专属环节时后端会拒绝）。
 */
export async function setManifestTransportMode(manifestId: string, transportMode: string): Promise<{ transportMode: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/transport-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id: manifestId, transportMode }),
  });
  return parseApiResponse(response);
}

/**
 * 获取装柜清单详情。
 */
export async function fetchLoadingManifestDetail(manifestId: string): Promise<LoadingManifestDetail> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/detail?id=${manifestId}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 封装装柜清单。
 */
export async function sealLoadingManifest(manifestId: string): Promise<{ message: string; manifest: { id: string; status: string } }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/seal?id=${manifestId}`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 添加运单到装柜清单。
 */
export async function removeShipmentFromManifest(manifestId: string, itemId: string, pieceCount?: number): Promise<{ message: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/remove-shipment?id=${manifestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ itemId, pieceCount }),
  });
  return parseApiResponse(response);
}

/**
 * 管理员删除柜子（仅 LOADING 状态）。
 */
export async function deleteContainer(containerId: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers?id=${encodeURIComponent(containerId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function addShipmentToManifest(manifestId: string, trackingNo: string, pieceCount?: number): Promise<{ message: string; trackingNo: string; isPartial?: boolean; parentTrackingNo?: string; warning?: string | null }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/add-shipment?id=${manifestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ trackingNo, pieceCount }),
  });
  return parseApiResponse(response);
}
export async function fetchShippingConfig(): Promise<Record<string, string>> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/config`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export interface ShippingPriceItem {
  unitPriceCny: number;
  disableMinVolume: boolean;
}

/** 推进柜子状态 */
export async function updateContainerStatus(payload: {
  id: string;
  toStatus: string;
  remark?: string;
  date?: string;
  /** 「下一站【泰国边境】」，不传则后端按状态取默认值 */
  nextStop?: string;
}): Promise<{ containerNo: string; fromStatus: string; toStatus: string; affectedShipmentCount: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 撤销这个柜子上一次的状态推进：柜子退回上一步，柜里每张运单那一批轨迹一起删掉。
 * 推错了整柜一次撤，不用一张张运单去删。
 */
export async function undoContainerStatus(id: string): Promise<{
  containerNo: string;
  undoneStatus: string;
  currentStatus: string;
  deletedLogs: number;
  affectedShipmentCount: number;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers/status/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id }),
  });
  return parseApiResponse(response);
}

export async function fetchShippingPrices(clientId?: string): Promise<Record<string, ShippingPriceItem>> {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  const response = await fetch(`${apiBaseUrl()}/client/shipping/prices${query}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchAdminShippingRates(): Promise<{
  items: Array<{
    id: string;
    transportMode: string;
    cargoType: string;
    customerId: string | null;
    customerName: string | null;
    unitPriceCny: number;
    disableMinVolume: boolean;
  }>;
  defaults: Array<{ transportMode: string; cargoType: string; unitPriceCny: number }>;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/rates`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}



export async function fetchClientShippingConfig(clientId: string): Promise<{
  clientId: string;
  prices: Record<string, number>;
  disableMinVolume: boolean;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/client-config?clientId=${encodeURIComponent(clientId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function saveClientShippingConfig(payload: {
  clientId: string;
  prices: Record<string, number>;
  disableMinVolume: boolean;
}): Promise<{ saved: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/client-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchClientNotes(): Promise<Record<string, { content: string; updatedAt: string }>> {
  const response = await fetch(`${apiBaseUrl()}/staff/lastmile/notes`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function saveClientNote(clientId: string, content: string): Promise<{ saved: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ clientId, content }),
  });
  return parseApiResponse(response);
}

export async function updateShippingConfig(payload: Record<string, string>): Promise<Record<string, string>> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

// ============================================================================
// 集货拼柜模块
// ============================================================================

/** 集货产品明细项 */
export interface ConsolidationProductItem {
  id: string;
  productName: string;
  packageCount: number;
  quantityPerBox: number;
  totalQuantity: number;
  unitWeight: number | null;
  totalWeight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  volume: number | null;
  material: string;
  cargoValue: string;
  productImageFileName: string | null;
  productImageMime: string | null;
  productImageBase64: string | null;
  sortOrder: number;
}

/** 集货预报单列表项 */
export interface ConsolidationPrealertItem {
  id: string;
  taskId: string;
  trackingNo: string;
  expressNo: string | null;
  mark: string;
  status: "pending" | "received";
  signedAt: string | null;
  receivedProofFileName: string | null;
  receivedProofMime: string | null;
  receivedProofBase64: string | null;
  products: ConsolidationProductItem[];
  createdAt: string;
}

/** 集货任务列表项 */
export interface ConsolidationTaskItem {
  id: string;
  taskNo: string;
  destinationTh: string;
  status: string;
  maxVolumeM3: number;
  totalVolumeM3: number;
  totalPackages: number;
  totalPrealerts: number;
  bookingFee: number | null;
  customsFee: number | null;
  loadingFee: number | null;
  totalFee: number | null;
  currency: string;
  paymentStatus: string;
  paidAt: string | null;
  paymentProofBase64: string | null;
  paymentProofUploadedAt: string | null;
  paymentRejectReason: string | null;
  paymentReviewedAt: string | null;
  containerNo: string | null;
  loadingDate: string | null;
  clientId?: string;
  clientName?: string;
  clientPhone?: string;
  createdAt: string;
  updatedAt: string;
  volumePercent: number;
  isNearFull: boolean;
  prealerts?: ConsolidationPrealertItem[];
  statusLogs?: any[];
}

// ============================================================================
// 客户端接口
// ============================================================================

/** 获取客户端集货任务列表 */
export async function fetchClientConsolidationTasks(status?: "active"): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/client/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取集货任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 获取客户端集货任务详情 */
export async function fetchClientConsolidationTaskDetail(taskId: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`获取任务详情失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 创建集货任务 */
export async function createConsolidationTask(destinationTh: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks`,
      { method: "POST", body: JSON.stringify({ destinationTh }) },
    );
  } catch (error) {
    throw new Error(`创建任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 修改任务目的地 */
export async function updateConsolidationTask(taskId: string, destinationTh: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks/update`,
      { method: "POST", body: JSON.stringify({ taskId, destinationTh }) },
    );
  } catch (error) {
    throw new Error(`更新任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 创建预报单 */
export async function createConsolidationPrealert(payload: {
  taskId: string;
  mark: string;
  expressNo?: string;
  products: Array<{
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<ConsolidationPrealertItem> {
  try {
    return await apiRequest<ConsolidationPrealertItem>(
      `${apiBaseUrl()}/client/consolidation/prealerts`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`创建预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 编辑预报单 */
export async function updateConsolidationPrealert(payload: {
  prealertId: string;
  mark?: string;
  expressNo?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行。不传 productImage 则沿用原图 */
    id?: string;
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<ConsolidationPrealertItem> {
  try {
    return await apiRequest<ConsolidationPrealertItem>(
      `${apiBaseUrl()}/client/consolidation/prealerts/update`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`编辑预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 删除预报单 */
export async function deleteConsolidationPrealert(prealertId: string): Promise<{ deleted: boolean; id: string }> {
  try {
    return await apiRequest<{ deleted: boolean; id: string }>(
      `${apiBaseUrl()}/client/consolidation/prealerts/delete`,
      { method: "POST", body: JSON.stringify({ prealertId }) },
    );
  } catch (error) {
    throw new Error(`删除预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 付款 */
/**
 * 管理员撤销一笔普通版集货付款：钱退回客户的集货余额，任务回到「未付款」。
 * 退多少由后端按流水里实际扣过的钱算。
 */
export async function revokeConsolidationPayment(payload: {
  taskId: string;
  reason?: string;
}): Promise<{ taskId: string; refunded: number; balanceAfter: number; message: string }> {
  return apiRequest(`${apiBaseUrl()}/admin/consolidation/payments/revoke`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 2026-08-07：改成用集货余额付款，不再传付款凭证 */
export async function payConsolidationTask(payload: {
  taskId: string;
}): Promise<{ success: boolean; taskId: string; paidAmount?: number; balanceAfter?: number; message?: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; paidAmount?: number; balanceAfter?: number; message?: string }>(
      `${apiBaseUrl()}/client/consolidation/pay`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// ============================================================================
// 员工端接口
// ============================================================================

/** 员工查所有客户任务列表 */
export async function fetchStaffConsolidationTasks(status?: string): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/staff/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 员工查任务详情 */
export async function fetchStaffConsolidationTaskDetail(taskId: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/staff/consolidation/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`获取任务详情失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 签收预报单 */
export async function receiveConsolidationPrealert(payload: {
  prealertId: string;
  proofBase64: string;
  proofFileName: string;
  proofMime: string;
}): Promise<{ success: boolean; prealertId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; prealertId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/prealerts/receive`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`签收预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 确认满柜 */
export async function confirmConsolidationTaskFull(taskId: string): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/confirm-full`,
      { method: "POST", body: JSON.stringify({ taskId }) },
    );
  } catch (error) {
    throw new Error(`确认满柜失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 录入报价 */
export async function quoteConsolidationTask(payload: {
  taskId: string;
  bookingFee: number;
  customsFee: number;
  loadingFee: number;
}): Promise<{ success: boolean; taskId: string; totalFee: number; isFirstQuote: boolean }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; totalFee: number; isFirstQuote: boolean }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/quote`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`报价失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 推进任务状态 */
export async function advanceConsolidationTaskStatus(payload: {
  taskId: string;
  toStatus: string;
  remark?: string;
}): Promise<{ success: boolean; taskId: string; fromStatus: string; toStatus: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; fromStatus: string; toStatus: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/advance-status`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`推进状态失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 装柜 */
export async function loadingConsolidationTask(payload: {
  taskId: string;
  containerNo?: string;
  loadingDate?: string;
}): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/loading`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`装柜失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 取消任务 */
export async function cancelConsolidationTask(taskId: string): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/cancel`,
      { method: "POST", body: JSON.stringify({ taskId }) },
    );
  } catch (error) {
    throw new Error(`取消任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 导出任务数据 */

/** 审核通过付款（员工/管理员） */
export async function reviewConsolidationPayment(taskId: string): Promise<void> {
  try {
    await apiRequest(`${apiBaseUrl()}/staff/consolidation/review-payment`, {
      method: "POST",
      body: JSON.stringify({ taskId }),
    });
  } catch (error) {
    throw new Error(`审核付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 审核拒绝付款（员工/管理员） */
export async function rejectConsolidationPayment(taskId: string, reason: string): Promise<void> {
  try {
    await apiRequest(`${apiBaseUrl()}/staff/consolidation/reject-payment`, {
      method: "POST",
      body: JSON.stringify({ taskId, reason }),
    });
  } catch (error) {
    throw new Error(`拒绝付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function exportConsolidationTask(taskId: string): Promise<{
  taskNo: string;
  taskId: string;
  totalRows: number;
  headers: Array<{ key: string; label: string }>;
  rows: Array<Record<string, any>>;
}> {
  try {
    return await apiRequest<{
      taskNo: string;
      taskId: string;
      totalRows: number;
      headers: Array<{ key: string; label: string }>;
      rows: Array<Record<string, any>>;
    }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/export?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`导出失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// ============================================================================
// 管理员端接口
// ============================================================================

/** 管理员查所有任务 */
export async function fetchAdminConsolidationTasks(status?: string): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/admin/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 管理员删除任务（级联删除） */
/** 删除集货任务时，后端返回的连带删除清单 */
export interface ConsolidationDeletePreview {
  taskNo?: string;
  planNo?: string;
  willDelete: Record<string, number>;
  blockers: string[];
  /** 删除时会退回客户集货余额的总金额（元）。2026-08-08 新增 */
  refundTotal?: number;
  /** 会退给几位客户 */
  refundCount?: number;
}

/**
 * 删除整个集货任务（管理员）。
 *
 * ⚠️ 2026-08-07 修：这个函数原来调的是 DELETE /admin/consolidation/tasks，
 * 而后端从来没有这个接口（只有 GET）—— 页面上的「删除任务」按钮点了必然失败。
 * 现在改调 POST /admin/consolidation/tasks/delete。
 *
 * dryRun=true 只预检不删，用来告诉用户「会连带删掉几张预报单」。
 * 已收货 / 任务已开始走流程时后端会拦（409），要带 confirmPassword 才放行。
 */
export async function deleteAdminConsolidationTask(
  taskId: string,
  opts?: { dryRun?: boolean; confirmPassword?: string },
): Promise<ConsolidationDeletePreview & { deleted?: boolean; forced?: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/consolidation/tasks/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, ...opts }),
  });
}

/**
 * 删除整个集货计划（仓库版，管理员，2026-08-07 新增）。
 * 级联链最长：计划 → 计划客户 → 预报单 → 货物明细 + 状态日志。
 * 用法与 deleteAdminConsolidationTask 一致：先 dryRun 预检，被拦时带 confirmPassword 强删。
 */
export async function deleteAdminWhrConsolidationPlan(
  planId: string,
  opts?: { dryRun?: boolean; confirmPassword?: string },
): Promise<ConsolidationDeletePreview & { deleted?: boolean; forced?: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/plans/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, ...opts }),
  });
}

/** 管理员强制编辑预报单 */
export async function adminForceEditConsolidationPrealert(payload: {
  prealertId: string;
  mark?: string;
  expressNo?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行。不传 productImage 则沿用原图 */
    id?: string;
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<{ success: boolean; prealertId: string }> {
  try {
    return await apiRequest<{ success: boolean; prealertId: string }>(
      `${apiBaseUrl()}/admin/consolidation/prealerts/force-edit`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`强制编辑预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 管理员强制删除预报单 */
export async function adminDeleteConsolidationPrealert(prealertId: string): Promise<{ deleted: boolean; prealertId: string }> {
  try {
    return await apiRequest<{ deleted: boolean; prealertId: string }>(
      `${apiBaseUrl()}/admin/consolidation/prealerts/delete`,
      { method: "POST", body: JSON.stringify({ prealertId }) },
    );
  } catch (error) {
    throw new Error(`删除预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}
