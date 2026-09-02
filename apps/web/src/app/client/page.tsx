"use client";


import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { validateProductRows, packageCountForPayload } from "../../modules/orders/productRowGuard";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
// 2026-08-31 收尾清理：formatCny 引入了但全文件没用过（历史遗留死 import），删掉
import { sendAiMessage } from "../../services/ai-client";
import { apiBaseUrl } from "../../services/core-api";
import { volumeM3FromDimensionsCm, formatVolumeM3String, warehouseLabelFromId } from "../../modules/staff/utils";
import {
  fetchClientAddresses,
  createClientPrealert,
  fetchClientPrealerts,
  // 预报单创建即已发货，不再需要确认发货
  // 2026-08-31（条目48）：deleteClientPrealert / updateClientPrealert 不再引入 ——
  // 它们只被那个没有任何入口的「编辑预报单」死弹窗用到，弹窗已删。
  fetchClientOrders,
  fetchClientWalletOverview,
  fetchClientShipmentOverview,
  uploadStaffOrderProductImage,
  fetchShipmentImages,
  type ClientAddressItem,
  type OrderItem,
  type OrderProductImageItem,
  type StaffShipmentOverview,
} from "../../services/business-api";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import { ShipmentOverviewStrip } from "../../modules/shipment/ShipmentOverviewStrip";
import DetailModal from "../../modules/layout/DetailModal";
import { shipmentStatusZh, CLIENT_STATUS_ZH_OVERRIDES, SHIPMENT_STATUS_FILTER_OPTIONS } from "../../modules/shipment/shipment-status";
import {
  GridColgroup,
  ProductDetailCell,
  gridThStyle,
  gridTdStyle,
  totalVolumeOf,
  totalWeightOf,
} from "../../modules/shipment/ShipmentTableGrid";
import FclInquiryPanel from "../../components/client/FclInquiryPanel";

const initialSearch = {
  batchNo: "",
  arrivedDateFrom: "",
  arrivedDateTo: "",
  domesticTrackingNo: "",
  status: "",
  transportMode: "",
  warehouseId: "",
};

const warehouseOptions = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];

const warehouseAddressMap: Record<string, string> = {
  wh_yiwu_01: "浙江省金华市义乌市北苑街道 xx 路 88 号（义乌仓）",
  wh_guangzhou_01: "广东省广州市白云区石井街道 xx 物流园 16 栋（广州仓）",
  wh_dongguan_01: "广东省东莞市虎门镇 xx 工业区 9 号（东莞仓）",
  wh_shenzhen_01: "（深圳仓地址待补充）",
};


const CLIENT_SECTION_IDS = ["client-main", "client-query", "client-prealert", "client-fcl"] as const;
/* ORDER_TIMELINE（装柜→开船→到港→清关→放行→到仓→派送→签收 八格进度条）
   2026-08-13 删除。它和 buildOrderTimeline / normalizeTimelineStatus 一起，
   **从来没有被渲染到页面上过** —— 三者互相调用，但没有任何 JSX 用到它们。
   已在浏览器里确认：客户端页面上找不到这条进度条。
   客户真正看到的是运单列表那一列状态，和「物流轨迹」弹窗，两处都走
   shipmentStatusZh，新加的环节都有中文。 */

/* 2026-08-31（条目18）：客户端「状态」筛选下拉的选项。
   复用员工端/管理员端那份从流程表自动生成的清单（加状态自动跟上），
   只有一处口径差异：客户端把 delivered 叫「已签收」，员工端叫「派送完成」，
   所以这里把那一个标签换掉，其余原样。比对逻辑见 runOrderQuery。 */
const clientStatusFilterOptions: string[] = SHIPMENT_STATUS_FILTER_OPTIONS.map((label) =>
  label === shipmentStatusZh("delivered") ? shipmentStatusZh("delivered", CLIENT_STATUS_ZH_OVERRIDES) : label,
);

/* 2026-08-31（条目48）删掉 PrealertPrintButton（连同它专用的
   VALID_PACKAGE_UNITS / VALID_TRANSPORT_MODES 两个常量和 openPrintLabel /
   openPrintPrealert 两个 import）：2026-06-28 预报单列表改成表格样式时，
   「编辑」「删除」「打印预报单」三个按钮一起被删了，这个组件从那天起
   没有任何地方渲染过。全文件 grep 过只剩定义没有使用。 */

function imgSrc(img: { imageUrl?: string | null }): string {
  return img.imageUrl ? apiBaseUrl() + img.imageUrl : "";
}

// ── localStorage 运单缓存 ──
const ORDERS_CACHE_PREFIX = "xt_orders_";
function getOrdersCacheKey(): string {
  try {
    const raw = localStorage.getItem("auth_session_v1");
    if (raw) { const session = JSON.parse(raw); if (session.userId) return ORDERS_CACHE_PREFIX + session.userId; }
  } catch { /* ignore */ }
  return ORDERS_CACHE_PREFIX + "unknown";
}
function loadOrdersFromCache(): OrderItem[] | null {
  try { const raw = localStorage.getItem(getOrdersCacheKey()); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveOrdersToCache(orders: OrderItem[]) {
  try { localStorage.setItem(getOrdersCacheKey(), JSON.stringify(orders)); } catch { /* quota */ }
}

/* 客户端运单列表的列宽。排版规则见 modules/shipment/ShipmentTableGrid.tsx。
   ⚠️ 第 3~4 个必须和 CLIENT_DETAIL_COL_WIDTHS 完全一致。 */
const CLIENT_DETAIL_COL_WIDTHS = [200, 160] as const;
const CLIENT_COL_WIDTHS = [110, 140, ...CLIENT_DETAIL_COL_WIDTHS, 100, 100, 80, 80, 110, 150, 160] as const;
const CLIENT_TABLE_MIN_WIDTH = CLIENT_COL_WIDTHS.reduce((a, b) => a + b, 0);
/** 弹性列＝「备注」（表头第 10 个） */
const CLIENT_FLEX_COL_INDEX = 9;

export default function ClientHomePage() {
  const [loading, setLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  /* 2026-08-31（条目23）：分组从「在途/已完成/全部」改成五个 ——
     全部订单(all=不传) / 未发出(pending) / 在途(transit) / 已签收(delivered) / 退回、取消、异常(closed)，
     值就是后端 /client/orders 的 statusGroup 参数，两边一份口径。 */
  const [queryMode, setQueryMode] = useState<"all"  |  "pending"  |  "transit"  |  "delivered"  |  "closed"  |  null>("all");
  const [queriedOrders, setQueriedOrders] = useState<OrderItem[]>([]);
  const [hasQueried, setHasQueried] = useState(false);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [dashboardOrders, setDashboardOrders] = useState<OrderItem[]>([]);
  const [prealertSearch, setPrealertSearch] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  /* 2026-08-31（条目48）：删掉 editingPrealert 状态和文件末尾那个「编辑预报单」弹窗。
     2026-06-28 起页面上就没有任何按钮能打开它（「编辑」按钮当时随列表改版一起删了），
     留着这段死代码会误导后来人以为客户能自己改预报单。
     客户要不要恢复自助编辑，等老板拍板后再把按钮和弹窗一起加回来。 */
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string }  |  null>(null);

  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  /* 2026-08-31（条目47）：预报单改成后端翻页。原来前端悄悄 .slice(0, pageSize)
     砍到前 50 条、不给翻页按钮，预报单多的老客户会以为旧单被删了。
     两处预报单列表（首页一份、侧边栏「预报单」页一份）共用这套页码和总数。 */
  const [prealertPage, setPrealertPage] = useState(1);
  const [prealertTotal, setPrealertTotal] = useState(0);
  /* 2026-08-31（条目47收尾）：预报单搜索池。改成后端翻页后，搜索框一度只能筛当前页——
     比改造前「一次拿全再筛」还退步。搜索词非空时一次拉前 500 条（后端上限就是 500）放这里本地筛；
     null = 没在搜索或还没拉到，列表走正常翻页。 */
  const [prealertSearchPool, setPrealertSearchPool] = useState<OrderItem[] | null>(null);

  /* 「我的运单查询」顶部那排数字。拉不到就整排不显示 ——
     宁可不显示，也不能显示一个假的 0 让客户以为「没有在途的」。 */
  const [shipmentOverview, setShipmentOverview] = useState<StaffShipmentOverview | null>(null);
  useEffect(() => {
    fetchClientShipmentOverview().then(setShipmentOverview).catch(() => setShipmentOverview(null));
  }, []);
  const [openLogisticsByOrder, setOpenLogisticsByOrder] = useState<Record<string, boolean>>({});
  const [openDetailsByOrder, setOpenDetailsByOrder] = useState<Record<string, boolean>>({});
  const [detailImagesCache, setDetailImagesCache] = useState<Record<string, OrderProductImageItem[]>>({});
  const [search, setSearch] = useState(initialSearch);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [form, setForm] = useState({
    warehouseId: "",
    itemName: "",
    packageCount: "",
    packageUnit: "box" as "bag"  |  "box",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    trackingNo: "",
    weightKg: "",
    volumeM3: "",
    domesticTrackingNo: "",
    transportMode: "" as ""  |  "sea"  |  "land",
    receiverNameTh: "",
    receiverPhoneTh: "",
    receiverAddressTh: "",
  });
  const [formProducts, setFormProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; domesticTrackingNo: string;
  }>>([]);
  const [prealertImageFiles, setPrealertImageFiles] = useState<File[]>([]);
  const [prealertImagePreviews, setPrealertImagePreviews] = useState<string[]>([]);
  const [addressBook, setAddressBook] = useState<ClientAddressItem[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [activeSection, setActiveSection] = useState<(typeof CLIENT_SECTION_IDS)[number]>("client-main");

  // 判断 hash 是否属于客户端可展示的功能分区。
  const isClientSectionId = (value: string): value is (typeof CLIENT_SECTION_IDS)[number] =>
    CLIENT_SECTION_IDS.includes(value as (typeof CLIENT_SECTION_IDS)[number]);

  const refreshMainData = async () => {
    const results = await Promise.allSettled([
      // 2026-08-31（条目47）：fetchClientPrealerts 改为返回 { items, total } 并按页取
      fetchClientPrealerts("all", { page: prealertPage, pageSize }),
      fetchClientOrders(),
      fetchClientWalletOverview(),
      fetchClientAddresses(),
    ]);
    if (results[0].status === "fulfilled") {
      setPrealerts(results[0].value.items);
      setPrealertTotal(results[0].value.total);
      // 2026-08-31（条目47收尾）：新建预报单后搜索池已过期，清掉让下面的搜索 effect 按需重拉
      setPrealertSearchPool(null);
    }
    if (results[1].status === "fulfilled") setDashboardOrders(results[1].value);
    // 2026-08-07 删除：这里原来读 results[2].value.exchangeRate.rate。
    // 后端 /client/wallet/overview 在集货余额改造后已不再返回 exchangeRate
    // （余额收窄成集货专用、只有人民币，用不着汇率），显示汇率的界面当时也一并删了，
    // 只剩这行还在读，于是客户一打开首页就报
    // 「Cannot read properties of undefined (reading 'rate')」。
    // 算出来的值本来就没往页面上放，直接删掉，不要用 ?. 糊过去。
    if (results[3].status === "fulfilled") setAddressBook(results[3].value);
  };

  /**
   * 更新长宽高并同步计算体积。
   */
  const updateOrderDimensions = (patch: Partial<Pick<typeof form, "lengthCm"  |  "widthCm"  |  "heightCm"  |  "packageCount">>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      const l = Number(String(next.lengthCm).trim());
      const w = Number(String(next.widthCm).trim());
      const h = Number(String(next.heightCm).trim());
      const pkg = Number(String(next.packageCount).trim());
      if (Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0) {
        const single = volumeM3FromDimensionsCm(l, w, h);
        next.volumeM3 = formatVolumeM3String(Number.isFinite(pkg) && pkg > 0 ? single * pkg : single);
      } else {
        next.volumeM3 = "";
      }
      return next;
    });
  };

  /**
   * 从地址簿快速填充收件信息。
   */
  const applyAddressBook = (addressId: string) => {
    const selected = addressBook.find((item) => item.id === addressId);
    if (!selected) return;
    setForm((prev) => ({
      ...prev,
      receiverNameTh: selected.contactName,
      receiverPhoneTh: selected.contactPhone,
      receiverAddressTh: selected.addressDetail,
    }));
  };

  useEffect(() => {
    setDashboardLoading(true);
    refreshMainData()
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setDashboardLoading(false));

  }, []);

  // 2026-08-31（条目47）：翻页/改每页条数时重拉预报单的那一页。
  // 首次挂载跳过 —— 第 1 页已经由上面 refreshMainData 拉过了，别重复请求。
  const prealertPageInitRef = useRef(true);
  useEffect(() => {
    if (prealertPageInitRef.current) {
      prealertPageInitRef.current = false;
      return;
    }
    fetchClientPrealerts("all", { page: prealertPage, pageSize })
      .then((result) => {
        setPrealerts(result.items);
        setPrealertTotal(result.total);
      })
      .catch(() => { /* 翻页失败保留当前页数据，不清空 */ });
  }, [prealertPage, pageSize]);

  // 2026-08-31（条目47收尾）：搜索词非空时拉一次前 500 条进搜索池，清空搜索就退回正常翻页。
  // 用 ref 挡住重复请求 —— 池子只拉一次，别每敲一个字都重拉。
  const prealertPoolLoadingRef = useRef(false);
  useEffect(() => {
    if (!prealertSearch.trim()) {
      setPrealertSearchPool(null);
      return;
    }
    if (prealertSearchPool !== null || prealertPoolLoadingRef.current) return;
    prealertPoolLoadingRef.current = true;
    fetchClientPrealerts("all", { page: 1, pageSize: 500 })
      .then((result) => setPrealertSearchPool(result.items))
      .catch(() => setToast("加载全部预报单失败，暂时只在当前页里搜"))
      .finally(() => { prealertPoolLoadingRef.current = false; });
  }, [prealertSearch, prealertSearchPool]);

  // 搜索中筛池子（池子没到之前先筛当前页顶着），没搜索就原样显示当前页。两处预报单列表共用这一份。
  const prealertSearchActive = prealertSearch.trim().length > 0;
  const visiblePrealerts = (prealertSearchActive && prealertSearchPool ? prealertSearchPool : prealerts).filter((item) => {
    const q = prealertSearch.trim().toLowerCase();
    if (!q) return true;
    return item.id.toLowerCase().includes(q) || (item.itemName ?? "").toLowerCase().includes(q);
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Auto-fill volume and weight from multi-product form
  useEffect(() => {
    if (formProducts.length === 0) return;
    const totalVol = formProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const l = Number(p.lengthCm) || 0;
      const w = Number(p.widthCm) || 0;
      const h = Number(p.heightCm) || 0;
      return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
    }, 0);
    const totalWt = formProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const wt = Number(p.weightKg) || 0;
      return s + wt * pkg;
    }, 0);
    setForm((v) => ({ ...v, volumeM3: totalVol > 0 ? String(totalVol.toFixed(6)) : v.volumeM3, weightKg: totalWt > 0 ? String(totalWt.toFixed(2)) : v.weightKg }));
  }, [formProducts]);

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isClientSectionId(hashId)) {
        setActiveSection(hashId);
      }
    };
    syncSectionByHash();
    window.addEventListener("hashchange", syncSectionByHash);
    return () => window.removeEventListener("hashchange", syncSectionByHash);
  }, []);

  const submitPrealert = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("");
    try {
      if (!form.warehouseId || !form.itemName.trim() || !form.transportMode) {
        setMessage("请填写仓库、品名、运输方式。");
        setLoading(false);
        return;
      }
      const result = await createClientPrealert({
        warehouseId: form.warehouseId,
        itemName: form.itemName.trim(),
        packageCount: Number(form.packageCount || 0),
        packageUnit: form.packageUnit,
        weightKg: form.weightKg ? Number(form.weightKg) : undefined,
        volumeM3: form.volumeM3 ? Number(form.volumeM3) : undefined,
        domesticTrackingNo: form.domesticTrackingNo.trim() || undefined,
        transportMode: form.transportMode as "sea"  |  "land",
        receiverNameTh: form.receiverNameTh.trim() || undefined,
        receiverPhoneTh: form.receiverPhoneTh.trim() || undefined,
        receiverAddressTh: form.receiverAddressTh.trim() || undefined,
      });
      setToast("预报单提交成功");
      setMessage(`预报单创建成功：${result.prealertId}`);
      await refreshMainData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "提交失败";
      setMessage(`提交失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const runOrderQuery = async () => {
    if (!queryMode) {
      setMessage("请先选择“全部订单”“未发出”“在途”“已签收”或“退回/取消/异常”。");
      return;
    }

    setLoading(true);
    setMessage("");
    /* 2026-09-01（老板实测抓到的竞态）：出发时记住当时的分组。
       原来这里没有「过期作废」防线——在「全部订单」下点「执行查询」、
       紧接着切到「在途」，慢的那个「全部」响应晚到会把在途列表整个盖掉：
       按钮亮着在途、列表却是 84 条全量（含已签收），要挂到下一轮 10 秒轮询才自愈。
       其余四个数据入口早都有这道防线，唯独这条路漏了。 */
    const modeAtStart = queryMode;
    try {
      const baseOrders =
        modeAtStart === "all"
          ? await fetchClientOrders()
          : await fetchClientOrders({ statusGroup: modeAtStart });
      if (queryModeRef.current !== modeAtStart) return; // 用户已切分组，这份结果作废
      const result = baseOrders
        .filter((item) => !search.batchNo || (item.trackingNo ?? "").toLowerCase().includes(search.batchNo.toLowerCase()))
        .filter((item) => {
          const d = item.createdAt.slice(0, 10);
          if (search.arrivedDateFrom && d < search.arrivedDateFrom) return false;
          if (search.arrivedDateTo && d > search.arrivedDateTo) return false;
          return true;
        })
        .filter((item) => {
          if (!search.domesticTrackingNo) return true;
          const kw = search.domesticTrackingNo.toLowerCase();
          if ((item.domesticTrackingNo ?? "").toLowerCase().includes(kw)) return true;
          // 同时搜索产品行的国内单号
          return (item.products ?? []).some((p: any) => (p.domesticTrackingNo ?? "").toLowerCase().includes(kw));
        })
        // 2026-08-31（条目18）：先把英文状态码翻成客户看到的中文再比对。
        // 原来拿下拉值和英文码硬比，客户照着列表抄「已开船」永远查出 0 条。
        .filter((item) => !search.status || shipmentStatusZh(item.currentStatus, CLIENT_STATUS_ZH_OVERRIDES) === search.status)
        .filter((item) => !search.transportMode || item.transportMode === search.transportMode)
        .filter((item) => !search.warehouseId || item.warehouseId === search.warehouseId);
      setQueriedOrders(result);
      // 2026-08-31（条目19）：换条件重查后页码必须回第 1 页，
      // 否则翻到第 3 页再查、新结果只有 1 页时，表格一片空白像丢了数据。
      setCurrentPage(1);
      setHasQueried(true);
      hasQueriedRef.current = true;
      if (modeAtStart === "all" && !search.batchNo && !search.arrivedDateFrom && !search.arrivedDateTo && !search.domesticTrackingNo && !search.status && !search.transportMode && !search.warehouseId) {
        saveOrdersToCache(result);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "查询失败";
      setMessage(`查询失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 查询区默认加载：进入“我的运单查询”后自动展示全部订单。
   */


  /**
   * 切换运单查询分组（全部/未发出/在途/已签收/退回取消异常）。
   *
   * 2026-08-31（条目20）：切分组后立刻查一次，别把客户晾着等 10 秒轮询 ——
   * 原来这里只清状态不查数，列表要空白到下一轮自动刷新才出来。
   * 响应回来时先核对 queryModeRef：客户连点两个分组时，慢的那个请求作废，
   * 不许拿旧分组的数据盖住新分组。
   */
  const changeQueryMode = (mode: "all"  |  "pending"  |  "transit"  |  "delivered"  |  "closed") => {
    setQueryMode(mode);
    setSearch(initialSearch);
    setHasQueried(false);
    hasQueriedRef.current = false;
    setQueriedOrders([]);
    setCurrentPage(1); // 2026-08-31（条目19）：切分组页码回第 1 页
    setMessage("");
    setLoading(true);
    fetchClientOrders(mode === "all" ? undefined : { statusGroup: mode })
      .then((orders) => {
        if (queryModeRef.current !== mode) return; // 已经切到别的分组了，这份结果作废
        setQueriedOrders(orders);
        setHasQueried(true);
        hasQueriedRef.current = true;
        if (mode === "all") saveOrdersToCache(orders);
      })
      .catch((error) => {
        if (queryModeRef.current !== mode) return;
        const text = error instanceof Error ? error.message : "查询失败";
        setMessage(`查询失败：${text}`);
      })
      .finally(() => setLoading(false));
  };

  const runAiSearch = async () => {
    const question = aiQuestion.trim();
    if (!question || aiLoading) return;
    setAiLoading(true);
    setAiAnswer("");
    try {
      const result = await sendAiMessage({ message: question });
      setAiAnswer(result.answer);
    } catch (error) {
      const text = error instanceof Error ? error.message : "AI 查询失败";
      setAiAnswer(`AI 查询失败：${text}`);
    } finally {
      setAiLoading(false);
    }
  };

  // 页面加载：缓存优先 → 瞬时显示 → 后台静默更新
  // 页面初始加载：缓存优先，后台静默刷新
  // 如果初始请求返回时用户已手动搜索，不覆盖结果
  useEffect(() => {
    const cached = loadOrdersFromCache();
    if (cached && cached.length > 0) {
      setQueriedOrders(cached);
      setQueryMode("all");
      // 2026-08-31（条目20）：读到缓存就把「已查询」开关打开，列表立刻显示。
      // 原来忘了开这个开关，客户进页面头 10 秒同时看到「正在加载」和「无匹配订单」，
      // 注释吹的「缓存秒开」实际完全没生效。
      // ⚠️ 只开 hasQueried，不动 hasQueriedRef —— ref 是「用户手动查过、别覆盖」的标记，
      // 缓存这份旧数据恰恰需要下面的后台请求来刷新，把 ref 设了后台刷新就被自己拦掉了。
      setHasQueried(true);
    }
    setDashboardLoading(true);
    fetchClientOrders()
      .then((orders) => {
        if (hasQueriedRef.current) return;
        if (queryModeRef.current !== "all") return; // 客户已切到别的分组，这份「全部」数据作废
        setQueriedOrders(orders);
        setQueryMode("all");
        // 2026-08-31（条目20）：自动加载成功也要开「已查询」开关，别等 10 秒轮询
        setHasQueried(true);
        saveOrdersToCache(orders);
      })
      .catch(() => {})
      .finally(() => setDashboardLoading(false));
  }, []);

  // 运单查询区 10 秒自动刷新（递归setTimeout，防请求堆积）
  // 用 ref 跟踪最新的 queryMode，避免轮询闭包拿到旧值
  const queryModeRef = useRef(queryMode);
  queryModeRef.current = queryMode;
  const hasQueriedRef = useRef(false);

  useEffect(() => {
    if (activeSection !== "client-query") return;
    // 有搜索条件时不自动刷新；纯浏览分组（在途/已完成/全部）正常刷新
    const hasFilter = search.batchNo || search.domesticTrackingNo || search.status || search.transportMode || search.warehouseId || search.arrivedDateFrom || search.arrivedDateTo;
    if (hasFilter || dashboardLoading) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const mode = queryModeRef.current;
        // 2026-08-31（条目23）：分组值改成 statusGroup 四分类，类型对上后不再需要 as 强转
        if (mode) {
          const orders = mode === "all"
            ? await fetchClientOrders()
            : await fetchClientOrders({ statusGroup: mode });
          // 2026-09-01：除 cancelled 外再核一次分组——极端时序下 cleanup 还没跑、响应先到
          if (!cancelled && queryModeRef.current === mode) { setQueriedOrders(orders); setHasQueried(true); }
          if (!cancelled && queryModeRef.current === mode && mode === "all") saveOrdersToCache(orders);
        }
      } catch { /* silent */ }
      if (!cancelled) timer = setTimeout(poll, 10000);
    };
    timer = setTimeout(poll, 10000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeSection, queryMode, dashboardLoading, search.batchNo, search.domesticTrackingNo, search.status, search.transportMode, search.warehouseId, search.arrivedDateFrom, search.arrivedDateTo]);

  const statusToneClass = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (value === "delivered" || value === "returned" || value === "cancelled") return "order-badge order-badge-land";
    if (value === "loaded" || value === "delaydeparted" || value === "departed" || value === "delayintransit" || value === "arrivedport" || value === "customsth" || value === "customscleared" || value === "inwarehouseth" || value === "outfordelivery") {
      return "order-badge order-badge-sea";
    }
    return "order-badge";
  };

  const warehouseLabel = warehouseLabelFromId;

  /* 2026-08-13 删掉三个死函数：logisticsStatusText / orderStatusText / statusLabel。
     它们各自抄了一份运单状态中文对照表，都停留在加新环节之前的老版本
     （查不到就返回「处理中」「未更新」）。全库 grep 过，三个都没有任何调用方 ——
     页面上真正在用的是共用那份 shipmentStatusZh（见第 1046 行那一列），
     所以删掉它们对界面没有任何影响，留着反而会被下一个人照着抄。
     ⚠️ 下面的 formatDateTime 原来夹在这三个函数中间，它是**在用**的，别一起删。 */

  /**
   * 将时间字符串格式化为“yyyy/MM/dd HH:mm:ss”。
   */
  const formatDateTime = (value?: string): string => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
  };

  /**
   * 构建物流状态变更记录（按时间升序，并补充时间段信息）。
   */
  const buildLogisticsTransitions = (
    records: OrderItem["logisticsRecords"]  |  undefined,
  ): Array<{
    fromStatus?: string;
    toStatus?: string;
    remark: string;
    changedAt: string;
    periodText: string;
    operatorRole?: string;
    operatorName?: string;
  }> => {
    const normalized = [...(records ?? [])].sort(
      (a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
    );
    return normalized.map((record, index) => {
      const next = normalized[index + 1];
      const start = formatDateTime(record.changedAt);
      const end = next ? formatDateTime(next.changedAt) : "至今";
      return {
        ...record,
        periodText: `${start} ~ ${end}`,
      };
    });
  };

  // 2026-08-07 移除：客户端「运费计算器」整块已下线（用户要求价格不对客户展示）。
  // 价格配置只保留管理员端；后端 /client/shipping/prices 也已收回客户权限。

  /**
   * 客户看板状态统计：用于状态卡片与图表展示。
   *
   * 2026-08-31 重写（条目16）。原来这张图全是错的：
   *   ① 「已完成」靠 group === "completed" 判断，但接口那时根本不返回 statusGroup，
   *      永远是 0（旁边「在途运单数」2026-08-07 就为同一个坑修过，这张图漏了）；
   *   ② 还用审批状态分流，已发货、已签收的单全被画成「处理中」。
   * 现在后端 /client/orders 已在每张单上带算好的 statusGroup 四分类
   * （pending=未发出 / transit=在途 / delivered=已签收 / closed=退回/取消/异常），
   * 直接按它画，口径和「我的运单查询」的分组按钮一致，别再自己发明算法。
   */
  const clientStatusData = useMemo(() => {
    const bucket = { pending: 0, transit: 0, delivered: 0, closed: 0 };
    dashboardOrders.forEach((item) => {
      const group = (item.statusGroup ?? "").toLowerCase();
      if (group === "delivered") bucket.delivered += 1;
      else if (group === "closed") bucket.closed += 1;
      else if (group === "transit") bucket.transit += 1;
      else bucket.pending += 1; // pending 或字段缺失的老数据，都归「未发出」
    });
    return [
      { name: "未发出", value: bucket.pending, color: "#B45309" },
      { name: "在途", value: bucket.transit, color: "#1e3a8a" },
      { name: "已签收", value: bucket.delivered, color: "#15803D" },
      { name: "退回/取消/异常", value: bucket.closed, color: "#B91C1C" },
    ];
  }, [dashboardOrders]);

  /* 2026-08-31 删除「中泰线路时效分析图」（clientEtaTrend + 那块 LineChart）：
     它的天数是公式编的（第几个订单 × 0.5 再加固定数），跟货实际走了几天无关，
     曲线永远单调上升。管理员端同款假公式 2026-08-21 已删掉换成后端真算的数据，
     客户端这份漏改了。拍板结果：直接撤掉，不接真接口。给客户看假数比不给还糟。 */

  /**
   * 客户可见「当前在途运单」：真正在路上（statusGroup=transit）的运单有几张。
   *
   * 2026-08-07 改。原来是「在途柜量」，写法是
   *   filter(statusGroup === "unfinished").map(batchNo) 去重取个数
   * 两处都是坏的：
   *   ① **接口根本不返回 statusGroup** —— 它只是个查询参数（?statusGroup=unfinished），
   *      不在响应字段里。所以这个筛选恒为假，「在途柜量」一直显示 0，不是今天改坏的。
   *   ② 柜号已对客户屏蔽（用户要求），而且生产库里只有 3% 的运单填了柜号，按它算本来就不准。
   *
   * 现在改成按运单自己的状态判断，口径和后端一致：
   * 后端 statusGroup 用的是 COMPLETED_STATUSES = delivered / returned / cancelled
   *（apps/api/src/modules/shipments/status-flow.ts:52），其余都算在途。
   * ⚠️ 后端那份清单改了，这里要跟着改。
   *
   * 2026-08-31 补注：上面「接口不返回 statusGroup」说的是当年的旧接口，
   * 现在 /client/orders 已经在每张单上带 statusGroup 四分类了（见 clientStatusData）。
   *
   * 2026-08-31 Codex 复核改：上一段补注原本说「这个数字保留按状态清单算、别改成数 transit」，
   * 结果同一页两个「在途」打架 —— 状态分布图按四分类只把 transit 算在途，
   * 这个数字却把未发出、异常的单也算进去，客户看着对不上号。
   * 拍板按四分类统一：这里也只数 statusGroup === "transit" 的单（后端算好的字段，直接用），
   * 前面那份手抄状态清单作废，别再照着它改回来。
   */
  const clientInTransitOrderCount = useMemo(
    () =>
      dashboardOrders.filter((item) => (item.statusGroup ?? "").toLowerCase() === "transit")
        .length,
    [dashboardOrders],
  );

  return (
    <RoleShell allowedRole="client" title="客户端工作台" variant="a3">
      <p style={{ color: "#4B5462", marginBottom: 20 }}>
        客户提交预报单后会先进入“预报中”，员工审核通过后会自动进入“我的订单”。
      </p>

      <section
        id="client-main"
        className="client-main-section"
        style={{ display: activeSection === "client-main" ? "block" : "none" }}
      >
        <div className="section-label section-label-primary">主业务区</div>
        <h2 style={{ marginTop: 0, fontSize: 20 }}>主页</h2>
        {/* 2026-08-31：原来这里还有一块「中泰线路时效分析图」，数据是公式编的假曲线，已整块删掉（见上面 clientEtaTrend 的删除说明） */}
        <div className="dashboard-grid-2" style={{ marginBottom: 12 }}>
          <div className="dashboard-panel">
            <div className="dashboard-panel-title">订单状态分布</div>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={clientStatusData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E4E6EC" />
                  <XAxis dataKey="name" stroke="#8B94A3" />
                  <YAxis stroke="#8B94A3" />
                  <Tooltip />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {clientStatusData.map((item) => (
                      <Cell key={item.name} fill={item.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="dashboard-panel" style={{ marginBottom: 12 }}>
          <div className="dashboard-panel-title">中泰海陆运路线概览（简化）</div>
          <div className="route-map-wrap">
            <div className="route-point route-point-cn">中国仓</div>
            <div className="route-line route-line-sea" />
            <div className="route-line route-line-land" />
            <div className="route-point route-point-th">泰国仓</div>
            <div className="route-counter">当前在途运单：{clientInTransitOrderCount} 张</div>
          </div>
        </div>

        {/* 预报单管理 */}
        <div style={{ marginBottom: 14, border: "1px solid var(--l-soft)", borderRadius: 10, padding: 12, background: "var(--white)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: "var(--ink-legacy)", fontSize: 16 }}>预报单</div>
            <button type="button" onClick={() => setShowCreateModal(true)}
              style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>创建预报单</button>
          </div>
          {/* 2026-08-31（条目47）：共 N 条改用后端 total（原来只数拿到的这一页），并补上翻页按钮 */}
          {/* 2026-08-31（条目47收尾）：搜索时换成搜索结果口径、藏起翻页按钮（搜的是一次拉回的 500 条池子，
              页码不起作用）；超过 500 条按条目21 明说只搜了前 500，别让客户以为搜遍了 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            {prealertSearchActive ? (
              <div style={{ fontSize: 12, color: "var(--t-strong)" }}>搜到 {visiblePrealerts.length} 条{prealertSearchPool === null ? "（正在加载全部预报单…先只搜当前页）" : prealertTotal > 500 ? `（共 ${prealertTotal} 条，仅搜索前 500 条）` : ""}</div>
            ) : (
            <div style={{ fontSize: 12, color: "var(--t-strong)" }}>共 {prealertTotal} 条 · 第 {prealertPage}/{Math.max(1, Math.ceil(prealertTotal / pageSize))} 页</div>
            )}
            {prealertSearchActive ? null : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" onClick={() => setPrealertPage((p) => Math.max(1, p - 1))} disabled={prealertPage <= 1} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: prealertPage <= 1 ? "var(--s-sunken)" : "var(--white)", color: prealertPage <= 1 ? "var(--t-faint)" : "var(--t-heading)", cursor: prealertPage <= 1 ? "default" : "pointer", fontSize: 12 }}>上一页</button>
              <button type="button" onClick={() => setPrealertPage((p) => Math.min(Math.max(1, Math.ceil(prealertTotal / pageSize)), p + 1))} disabled={prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "var(--s-sunken)" : "var(--white)", color: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "var(--t-faint)" : "var(--t-heading)", cursor: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "default" : "pointer", fontSize: 12 }}>下一页</button>
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPrealertPage(1); setCurrentPage(1); /* 2026-08-31（条目19/47）：改每页条数，两张表页码都回第 1 页 */ }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
                {/* 2026-08-31（复查条目3）：去掉 1000 这一档 —— 后端 /client/prealerts 每页最多回 500 条，
                    选 1000 时页数按 1000 算、实际只回 500，后一半既看不到也翻不到，又是静默截断（教训21）。
                    这个下拉同时管运单查询表的每页条数（那张表是纯前端切片，1000 本身没事），
                    但为了不做成两个下拉，一起压到 500 一页，够用。 */}
                {[20, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}条/页</option>)}
              </select>
            </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={prealertSearch} onChange={(e) => setPrealertSearch(e.target.value)}
              placeholder="搜索单号、品名…"
              style={{ flex: 1, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
          </div>
          {prealerts.length === 0 ? (
            <div style={{ color: "var(--t-strong)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无预报单</div>
          ) : (
                        <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ borderBottom: "2px solid var(--l-soft)", textAlign: "left", background: "var(--s-cool)" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>唛头</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>预报单号</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>品名</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>尺寸(cm)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>体积(m³)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>重量(kg)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>件</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>运输</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>状态</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>备注</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>操作</th>
                </tr></thead>
                <tbody>
                  {/* 2026-08-31（条目47）：删掉这里原来的 .slice(0, pageSize) —— 现在后端按页返回，
                      再切一刀会把整页数据砍半。搜索改在 visiblePrealerts 里统一做：
                      搜索词非空时筛的是一次拉回的前 500 条池子，不再只筛当前页。 */}
                  {visiblePrealerts.map((item) => {
                    const isShipped = item.approvalStatus === "shipped";
                    const isReceived = item.approvalStatus === "received";
                    const sLabel = isReceived ? "已收货" : "已发货";
                    const sColor = isReceived ? "var(--c-green-3)" : "#1e3a8a";
                    const sBg = isReceived ? "#dcfce7" : "#EEF2FB";
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", color: "#14171D", fontSize: 12 }}>{item.clientId || "—"}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{item.orderNo || "—"}<br /><span style={{ fontSize: 10, color: "var(--t-muted)" }}>{item.trackingNo || ""}</span></td>
                        <td style={{ padding: "6px 8px" }}>{item.itemName}</td>
                        <td style={{ padding: "6px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{(() => { const dims = (item.products ?? []).map((p: any) => (p.lengthCm && p.widthCm && p.heightCm ? p.lengthCm + "×" + p.widthCm + "×" + p.heightCm : null)).filter(Boolean).join(", "); return dims || "—"; })()}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.volumeM3 != null ? Number(item.volumeM3).toFixed(3) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.weightKg != null ? Number(item.weightKg).toFixed(2) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</td>
                        <td style={{ padding: "6px 8px" }}><span className={item.transportMode === "sea" ? "tag tag-sea" : "tag tag-land"}>{item.transportMode === "sea" ? "海运" : "陆运"}</span></td>
                        <td style={{ padding: "6px 8px" }}><span style={{ fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 6px", borderRadius: 4 }}>{sLabel}</span></td>
                        <td style={{ padding: "6px 8px", fontSize: 12, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis" }} title={item.remark || ""}>{item.remark || ""}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                          {item.trackingNo ? <button type="button" onClick={() => openShipmentTrack(item.trackingNo!)} style={{ border: "1px solid var(--c-blue)", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "var(--c-blue-bg)", color: "var(--c-blue)", cursor: "pointer" }}>物流轨迹</button> : <span style={{ fontSize: 11, color: "var(--t-faint)" }}>暂无物流轨迹</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          )}

        </div>

        <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, marginBottom: 12, background: "var(--s-cool)" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>AI问答</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              placeholder="例如：我的运单现在到哪了？"
              style={{ flex: 1, border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void runAiSearch();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void runAiSearch()}
              disabled={aiLoading}
              style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "#1e3a8a" }}
            >
              {aiLoading ? "查询中..." : "AI 搜索"}
            </button>
          </div>
          {aiAnswer ? (
            <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "var(--t-strong)", fontSize: 13 }}>{aiAnswer}</div>
          ) : null}
        </div>
      </section>

      {activeSection === "client-main" || activeSection === "client-query" ? (
        <div className="section-divider" aria-hidden />
      ) : null}

      <section
        id="client-query"
        className="client-query-section"
        style={{ display: activeSection === "client-query" ? "block" : "none" }}
      >
        <div className="section-label section-label-query">查询区</div>
        {/* 2026-08-11：这里原来有个「折叠」按钮，点一下把整个查询区（筛选框 + 三个分组按钮）
            全收起来。用户判断没用 —— 客户来这一页就是为了查单，把查询框藏起来不是常做的事，
            不小心点到还会以为「搜索不见了」。整块删掉，查询区常驻。 */}
        <div style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>我的运单查询</h2>
        </div>

        {/* 顶部一排数字（2026-08-10 用户要三端都有，且「跟员工端一模一样」）。
            客户端走 /client/shipments/overview，只数自己名下的运单。 */}
        <ShipmentOverviewStrip data={shipmentOverview} />

        {/* 折叠按钮删掉后，这块（分组按钮 + 查询框 + 列表）常驻显示，不再用条件包着 */}
        <>
            {/* 2026-08-31（条目23）：原来是「订单在途/订单已完成/全部订单」三个按钮，
                名字和实际查的东西对不上（刚创建没发走的也算「在途」，退回/取消算「已完成」）。
                拍板改成五个分组，值直接用后端的 statusGroup 口径。 */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              {([
                { mode: "all", label: "全部订单" },
                { mode: "pending", label: "未发出" },
                { mode: "transit", label: "在途" },
                { mode: "delivered", label: "已签收" },
                { mode: "closed", label: "退回/取消/异常" },
              ] as const).map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeQueryMode(mode)}
                  style={{
                    border: "none",
                    borderRadius: 999,
                    padding: "6px 14px",
                    color: "var(--white)",
                    background: queryMode === mode ? "var(--c-blue)" : "var(--t-strong)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

        {/* 折叠按钮已删（2026-08-11），这里不能再说「已折叠」「展开搜索框」——
            现在只是还没选分组，照实说就行 */}
        {!queryMode ? (
          <EmptyStateCard title="请先选择要看哪些订单" description="点上面的「全部订单」「未发出」「在途」「已签收」或「退回/取消/异常」，下面就会列出来。" />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
              {/* 2026-08-11：原来这里并排放了**两个都写着「运单号」**的框，
                  客户分不清该填哪个 —— 而且实测两个筛的是同一个字段（都在 trackingNo 上做包含匹配），
                  填哪个、填一个还是两个都填，结果完全一样。
                  batchNo 这个名字是早年存柜号留下的，柜号 2026-08-07 已经对客户屏蔽，
                  这个框就只剩「按运单号筛」一个作用。留一个就够。 */}
              <input
                value={search.batchNo}
                onChange={(e) => setSearch((v) => ({ ...v, batchNo: e.target.value }))}
                placeholder="运单号"
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              />
              <div style={{ display: "flex", gap: 4, alignItems: "center", gridColumn: "span 2" }}>
                <input
                  type="date"
                  value={search.arrivedDateFrom}
                  onChange={(e) => setSearch((v) => ({ ...v, arrivedDateFrom: e.target.value }))}
                  style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", flex: 1 }}
                  placeholder="到仓起始"
                />
                <span style={{ fontSize: 12, color: "var(--t-muted)" }}>~</span>
                <input
                  type="date"
                  value={search.arrivedDateTo}
                  onChange={(e) => setSearch((v) => ({ ...v, arrivedDateTo: e.target.value }))}
                  style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", flex: 1 }}
                  placeholder="到仓截止"
                />
              </div>
              <div style={{ position: "relative", width: "100%", display: "none" }}>
                <input type="date" style={{ display: "none" }} />
                {(!search.arrivedDateFrom && !search.arrivedDateTo) ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 36,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "var(--t-strong)",
                      pointerEvents: "none",
                    }}
                  >
                    到仓日期
                  </div>
                ) : null}
              </div>
              <input
                value={search.domesticTrackingNo}
                onChange={(e) => setSearch((v) => ({ ...v, domesticTrackingNo: e.target.value }))}
                placeholder="国内快递单号"
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              />
              {/* 2026-08-31（条目18）：原来是个随便填字的输入框，却拿填的字去和英文状态码
                  （如 departed）精确比对 —— 客户照着列表抄「已开船」永远查出 0 条。
                  改成下拉框，选项从员工端/管理员端共用的那份自动生成的清单来
                  （delivered 按客户端口径显示成「已签收」），比对时把状态翻成中文再匹配，
                  和管理员端 orderSearch 的做法一致。不用英文码做值，是因为同一个中文状态
                  可能对应多个英文码（「已到仓」就有三种写法），按码精确比对会漏单。 */}
              <select
                value={search.status}
                onChange={(e) => setSearch((v) => ({ ...v, status: e.target.value }))}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">状态（全部）</option>
                {clientStatusFilterOptions.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                value={search.transportMode}
                onChange={(e) => setSearch((v) => ({ ...v, transportMode: e.target.value }))}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              <select
                value={search.warehouseId}
                onChange={(e) => setSearch((v) => ({ ...v, warehouseId: e.target.value }))}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">仓库（全部）</option>
                {warehouseOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => void runOrderQuery()}
                disabled={loading}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--c-blue)" }}
              >
                执行查询
              </button>
              <button
                type="button"
                onClick={() => {
                  // 2026-08-31（复查条目26）：清空条件直接复用 changeQueryMode ——
                  // 它本来就会清搜索条件、页码回第 1 页（条目19），并立刻按当前分组查一次。
                  // 原来这里只清状态不查数，列表消失后要空等 10 秒轮询才回来，
                  // 和条目20修掉的「切分组空等」是同一个病，只是入口不同。
                  changeQueryMode(queryMode ?? "all");
                }}
                style={{ border: "1px solid #E4E6EC", borderRadius: 8, padding: "8px 14px", background: "var(--white)", color: "var(--t-strong)" }}
              >
                清空条件
              </button>
            </div>

            {!hasQueried ? (
              <EmptyStateCard
                title="正在加载订单"
                description="已自动为你加载“全部订单”，你也可调整条件后点击“执行查询”。"
              />
            ) : queriedOrders.length === 0 ? (
              <EmptyStateCard title="无匹配订单" description="可调整查询条件后重新查询。" />
            ) : null}
          </>
        )}

            {hasQueried && queriedOrders.length > 0 ? (
            <>
            {(() => {
              const totalPages = Math.max(1, Math.ceil(queriedOrders.length / pageSize));
              return (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--t-heading)", fontWeight: 500 }}>共 {queriedOrders.length} 条 · 第 {currentPage}/{totalPages} 页</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: currentPage <= 1 ? "var(--s-sunken)" : "var(--white)", color: currentPage <= 1 ? "var(--t-faint)" : "var(--t-heading)", cursor: currentPage <= 1 ? "default" : "pointer", fontSize: 13, fontWeight: 500 }}>上一页</button>
                    <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: currentPage >= totalPages ? "var(--s-sunken)" : "var(--white)", color: currentPage >= totalPages ? "var(--t-faint)" : "var(--t-heading)", cursor: currentPage >= totalPages ? "default" : "pointer", fontSize: 13, fontWeight: 500 }}>下一页</button>
                  </div>
                </div>
              );
            })()}
            <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", minWidth: CLIENT_TABLE_MIN_WIDTH }}>
                <GridColgroup widths={CLIENT_COL_WIDTHS} flexIndex={CLIENT_FLEX_COL_INDEX} />
                <thead><tr style={{ borderBottom: "2px solid var(--l-soft)", textAlign: "left", background: "var(--s-cool-2)" }}>
                  <th style={gridThStyle}>唛头</th><th style={gridThStyle}>运单号</th><th style={gridThStyle}>品名</th><th style={gridThStyle}>尺寸(cm)</th><th style={gridThStyle}>体积(m³)</th><th style={gridThStyle}>重量(kg)</th><th style={gridThStyle}>总箱数</th><th style={gridThStyle}>运输</th><th style={gridThStyle}>物流状态</th><th style={gridThStyle}>备注</th><th style={gridThStyle}>操作</th>
                </tr></thead>
                <tbody>
                  {queriedOrders.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((item: any) => {
                    const st = item.currentStatus || "";
                    /* 状态中文对照挪到 modules/shipment/shipment-status.ts，三端共用一份。
                       原来这里少了 pickedUp、inWarehouseCN，客户会看到英文单词。 */
                    /* 品名和尺寸是「一个产品一行」，合成一块一起滚，行高才统一 */
                    const detailRows: string[][] = (item.products?.length ?? 0) > 0
                      ? (item.products ?? []).map((p: any) => [
                          p.itemName ?? "—",
                          p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}` : "—",
                        ])
                      : [[item.itemName || "未填品名", "—"]];
                    const isExpanded = !!openDetailsByOrder[item.id];
                    const cargoTypeLabel = item.cargoType === "inspection" ? "商检" : item.cargoType === "sensitive" ? "敏感" : "普货";
                    const images = detailImagesCache[item.id] ?? [];
                    const totalVolumeM3 = totalVolumeOf(item);
                    const totalWeightKg = totalWeightOf(item);
                    return (
                      <Fragment key={item.id}>
                        <tr style={{ borderBottom: isExpanded ? "none" : "1px solid var(--l-soft)", background: isExpanded ? "var(--s-cool)" : "var(--white)" }}>
                          <td style={{ ...gridTdStyle, fontFamily: "monospace", color: "#14171D", fontSize: 12 }}>{item.clientId || "—"}</td>
                          <td style={{ ...gridTdStyle, fontFamily: "monospace", fontSize: 11 }}>
                            <div>{item.trackingNo || "—"}</div>
                            <div style={{ fontSize: 10, color: "var(--t-muted)" }}>{item.orderNo || ""}</div>
                            {/* 明细块只露 3 行，这里写清楚一共几项 */}
                            <div style={{ fontSize: 10, color: "var(--t-muted)", marginTop: 2 }}>共 {detailRows.length} 项</div>
                          </td>
                          {/* 品名 / 尺寸：合并成一块，固定高度一起滚 */}
                          <ProductDetailCell widths={CLIENT_DETAIL_COL_WIDTHS} rows={detailRows} />
                          <td style={gridTdStyle} className="col-num">{totalVolumeM3 != null ? totalVolumeM3.toFixed(3) : "—"}</td>
                          <td style={gridTdStyle} className="col-num">{totalWeightKg != null ? totalWeightKg.toFixed(2) : "—"}</td>
                          <td style={gridTdStyle} className="col-num">{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</td>
                          <td style={gridTdStyle}><span className={item.transportMode === "sea" ? "tag tag-sea" : "tag tag-land"}>{item.transportMode === "sea" ? "海运" : "陆运"}</span></td>
                          <td style={gridTdStyle}>{shipmentStatusZh(st, CLIENT_STATUS_ZH_OVERRIDES)}</td>
                          <td style={{ ...gridTdStyle, fontSize: 12 }} title={item.remark || ""}>{item.remark || ""}</td>
                          {/* 详情挪到最右边，和物流轨迹并排横着放；原来它在最左边只有 30px 宽，
                              「详情」两个字被挤成上下两行 */}
                          <td style={gridTdStyle}>
                            <button type="button" onClick={async () => {
                              const next = { ...openDetailsByOrder };
                              if (next[item.id]) { delete next[item.id]; } else {
                                next[item.id] = true;
                                if (!detailImagesCache[item.id]) {
                                  try { const imgs = await fetchShipmentImages(item.id); setDetailImagesCache((prev) => ({ ...prev, [item.id]: imgs })); } catch (e) { console.error("加载产品图失败:", item.id, item.trackingNo, e); }
                                }
                              }
                              setOpenDetailsByOrder(next);
                            }} className="row-act">
                              详情
                            </button>
                            {item.trackingNo ? <button onClick={() => openShipmentTrack(item.trackingNo!)} className="row-act">物流轨迹</button> : <span style={{ fontSize: 11, color: "var(--t-faint)" }}>暂无轨迹</span>}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            {/* 详情改成全屏弹窗：格子只作挂载点，内容用 position:fixed 铺满屏幕，
                                所以这一行不占高度，表格不会被撑开 */}
                            <td colSpan={CLIENT_COL_WIDTHS.length} style={{ padding: 0, border: "none" }}>
                              <DetailModal
                                title="运单详情"
                                subtitle={item.trackingNo ?? item.orderNo ?? "—"}
                                onClose={() => setOpenDetailsByOrder((prev) => ({ ...prev, [item.id]: false }))}
                              >
                                  <div>
                              {/* 基本信息 */}
                              <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>基本信息</h4>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px 16px", marginBottom: 12 }}>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>仓库：</span>{warehouseLabel(item.warehouseId)}</div>
                                {/* 2026-08-07 删除「批次号」：它存的就是柜号，用户要求客户不能看到柜号。
                                    后端 /client/orders 已同时不再下发 batchNo，两边一起改，不留半截。 */}
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>运单号：</span>{item.trackingNo || "—"}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>预报单号：</span>{item.orderNo || "—"}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>审批状态：</span>{item.approvalStatus === "shipped" ? "已发货" : item.approvalStatus === "approved" ? "已审核" : item.approvalStatus || "—"}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>运输方式：</span>{item.transportMode === "sea" ? "海运" : item.transportMode === "land" ? "陆运" : item.transportMode || "—"}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>国内单号：</span>{(item.products?.length ?? 0) > 0 ? (item.products ?? []).map((p: any) => p.domesticTrackingNo || "—").filter(Boolean).join("、") || "—" : (item.domesticTrackingNo || "—")}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>发货日期：</span>{item.shipDate || "—"}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>货型：</span>{cargoTypeLabel}</div>
                                <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>收货地址：</span>{item.receiverAddressTh || "—"}</div>
                              </div>
                              {/* 产品明细 */}
                              {(item.products?.length ?? 0) > 0 ? (
                                <div style={{ marginBottom: 12 }}>
                                  <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>产品明细</h4>
                                  <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                    <thead><tr style={{ background: "var(--s-cool-2)" }}>
                                      <th style={{ padding: "4px 6px", textAlign: "left" }}>品名</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>件数</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>单箱数量</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>尺寸(cm)</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>重量(kg)</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>货型</th>
                                      <th style={{ padding: "4px 6px", textAlign: "center" }}>国内单号</th>
                                    </tr></thead>
                                    <tbody>
                                      {(item.products ?? []).map((p: any, i: number) => (
                                        <tr key={p.id || i} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                                          <td style={{ padding: "4px 6px" }}>{p.itemName}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.packageCount}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.productQuantity ?? "—"}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center", fontSize: 11 }}>{p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}` : "—"}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.weightKg != null ? p.weightKg : "—"}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.cargoType === "inspection" ? "商检" : p.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                          <td style={{ padding: "4px 6px", textAlign: "center", fontSize: 11 }}>{p.domesticTrackingNo || "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : null}
                              {/* 产品图片 */}
                              <div>
                                <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>产品图片</h4>
                                {images.length === 0 ? <span style={{ fontSize: 12, color: "var(--t-faint)" }}>暂无</span> : (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                    {images.map((img) => (
                                      <img key={img.id} src={imgSrc(img)} alt={img.fileName} onClick={() => setPreviewImage({ src: imgSrc(img), alt: img.fileName })} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} />
                                    ))}
                                  </div>
                                )}
                              </div>
                                  </div>
                              </DetailModal>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          ) : (
            <EmptyStateCard title="无匹配订单" description="可调整查询条件后重新查询。" />
          )}
        </>

      </section>

      {activeSection === "client-query" || activeSection === "client-prealert" ? (
        <div className="section-divider" aria-hidden />
      ) : null}
      <section
        id="client-prealert"
        style={{ display: activeSection === "client-prealert" ? "block" : "none" }}
      >
        {/* 预报单管理 */}
        <div style={{ marginBottom: 14, border: "1px solid var(--l-soft)", borderRadius: 10, padding: 12, background: "var(--white)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: "var(--ink-legacy)", fontSize: 16 }}>预报单</div>
            <button type="button" onClick={() => setShowCreateModal(true)}
              style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>创建预报单</button>
          </div>
          {/* 2026-08-31（条目47）：这个专页原来连「共多少条」都不显示，超过一页的老单翻不到
              也没人知道还有更多。补上总数和翻页，和首页那份共用同一套页码。 */}
          {/* 2026-08-31（条目47收尾）：搜索时换成搜索结果口径、藏起翻页按钮，口径和首页那份一致 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            {prealertSearchActive ? (
              <div style={{ fontSize: 12, color: "var(--t-strong)" }}>搜到 {visiblePrealerts.length} 条{prealertSearchPool === null ? "（正在加载全部预报单…先只搜当前页）" : prealertTotal > 500 ? `（共 ${prealertTotal} 条，仅搜索前 500 条）` : ""}</div>
            ) : (
            <div style={{ fontSize: 12, color: "var(--t-strong)" }}>共 {prealertTotal} 条 · 第 {prealertPage}/{Math.max(1, Math.ceil(prealertTotal / pageSize))} 页</div>
            )}
            {prealertSearchActive ? null : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" onClick={() => setPrealertPage((p) => Math.max(1, p - 1))} disabled={prealertPage <= 1} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: prealertPage <= 1 ? "var(--s-sunken)" : "var(--white)", color: prealertPage <= 1 ? "var(--t-faint)" : "var(--t-heading)", cursor: prealertPage <= 1 ? "default" : "pointer", fontSize: 12 }}>上一页</button>
              <button type="button" onClick={() => setPrealertPage((p) => Math.min(Math.max(1, Math.ceil(prealertTotal / pageSize)), p + 1))} disabled={prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "var(--s-sunken)" : "var(--white)", color: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "var(--t-faint)" : "var(--t-heading)", cursor: prealertPage >= Math.max(1, Math.ceil(prealertTotal / pageSize)) ? "default" : "pointer", fontSize: 12 }}>下一页</button>
            </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={prealertSearch} onChange={(e) => setPrealertSearch(e.target.value)}
              placeholder="搜索单号、品名…"
              style={{ flex: 1, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
          </div>
          {prealerts.length === 0 ? (
            <div style={{ color: "var(--t-strong)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无预报单</div>
          ) : (
                        <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ borderBottom: "2px solid var(--l-soft)", textAlign: "left", background: "var(--s-cool)" }}>
                  <th style={{ padding: "6px 8px", fontWeight: 600 }}>唛头</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>预报单号</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>品名</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>尺寸(cm)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>体积(m³)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>重量(kg)</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>件</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>运输</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>状态</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>备注</th><th style={{ padding: "6px 8px", fontWeight: 600 }}>操作</th>
                </tr></thead>
                <tbody>
                  {/* 2026-08-31（条目47）：删掉这里原来的 .slice(0, pageSize) —— 现在后端按页返回，
                      再切一刀会把整页数据砍半。搜索改在 visiblePrealerts 里统一做：
                      搜索词非空时筛的是一次拉回的前 500 条池子，不再只筛当前页。 */}
                  {visiblePrealerts.map((item) => {
                    const isShipped = item.approvalStatus === "shipped";
                    const isReceived = item.approvalStatus === "received";
                    const sLabel = isReceived ? "已收货" : "已发货";
                    const sColor = isReceived ? "var(--c-green-3)" : "#1e3a8a";
                    const sBg = isReceived ? "#dcfce7" : "#EEF2FB";
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", color: "#14171D", fontSize: 12 }}>{item.clientId || "—"}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{item.orderNo || "—"}<br /><span style={{ fontSize: 10, color: "var(--t-muted)" }}>{item.trackingNo || ""}</span></td>
                        <td style={{ padding: "6px 8px" }}>{item.itemName}</td>
                        <td style={{ padding: "6px 8px", fontSize: 11, whiteSpace: "nowrap" }}>{(() => { const dims = (item.products ?? []).map((p: any) => (p.lengthCm && p.widthCm && p.heightCm ? p.lengthCm + "×" + p.widthCm + "×" + p.heightCm : null)).filter(Boolean).join(", "); return dims || "—"; })()}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.volumeM3 != null ? Number(item.volumeM3).toFixed(3) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.weightKg != null ? Number(item.weightKg).toFixed(2) : "—"}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }} className="col-num">{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</td>
                        <td style={{ padding: "6px 8px" }}><span className={item.transportMode === "sea" ? "tag tag-sea" : "tag tag-land"}>{item.transportMode === "sea" ? "海运" : "陆运"}</span></td>
                        <td style={{ padding: "6px 8px" }}><span style={{ fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 6px", borderRadius: 4 }}>{sLabel}</span></td>
                        <td style={{ padding: "6px 8px", fontSize: 12, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis" }} title={item.remark || ""}>{item.remark || ""}</td>
                        <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                          {item.trackingNo ? <button type="button" onClick={() => openShipmentTrack(item.trackingNo!)} style={{ border: "1px solid var(--c-blue)", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "var(--c-blue-bg)", color: "var(--c-blue)", cursor: "pointer" }}>物流轨迹</button> : <span style={{ fontSize: 11, color: "var(--t-faint)" }}>暂无物流轨迹</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

          )}

        </div>

      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "var(--c-red-deep)" : "var(--c-green-deep)" }}>{message}</p> : null}

      {/* 创建预报单弹窗 */}
      {showCreateModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 1200, maxHeight: "90vh", overflow: "auto", background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建预报单</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <select value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                <option value="">选择仓库</option>
                {warehouseOptions.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
              </select>
              {/* Multi-product section */}
              <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, background: "var(--s-alt)" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--t-strong)" }}>产品列表</div>
                {formProducts.length === 0 ? (
                  <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名 *" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
                ) : null}
                {formProducts.map((p, i) => {
                  const pPkg = Number(p.packageCount) || 0;
                  const pL = Number(p.lengthCm) || 0;
                  const pW = Number(p.widthCm) || 0;
                  const pH = Number(p.heightCm) || 0;
                  const pWt = Number(p.weightKg) || 0;
                  const prodVol = (pL > 0 && pW > 0 && pH > 0) ? (pL * pW * pH * pPkg) / 1_000_000 : 0;
                  const prodWt = pWt * pPkg;
                  return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "3fr 0.5fr 0.4fr 0.4fr 0.4fr 0.5fr 0.5fr 1fr 1fr 1fr auto", gap: 3, marginBottom: 4, alignItems: "center" }}>
                    <input value={p.itemName} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], itemName: e.target.value }; return n; })} placeholder="品名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" value={p.packageCount} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], packageCount: e.target.value }; return n; })} placeholder="箱数" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], lengthCm: e.target.value }; return n; })} placeholder="长cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.widthCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], widthCm: e.target.value }; return n; })} placeholder="宽cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.heightCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], heightCm: e.target.value }; return n; })} placeholder="高cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" value={p.productQuantity} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], productQuantity: e.target.value }; return n; })} placeholder="单箱数量" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.weightKg} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], weightKg: e.target.value }; return n; })} placeholder="单箱重量kg" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input value={p.domesticTrackingNo || ""} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; return n; })} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <span style={{ fontSize: 11, color: prodVol > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 4px" }}>{prodVol > 0 ? prodVol.toFixed(4) + "m³" : "---"}</span>
                    <span style={{ fontSize: 11, color: prodWt > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 4px" }}>{prodWt > 0 ? prodWt.toFixed(2) + "kg" : "---"}</span>
                    <button type="button" onClick={() => setFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 6px", fontSize: 11, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer" }}>×</button>
                  </div>
                );})}
                {(() => {
                  const totalVol = formProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const l = Number(p.lengthCm) || 0;
                    const w = Number(p.widthCm) || 0;
                    const h = Number(p.heightCm) || 0;
                    return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
                  }, 0);
                  const totalWt = formProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const wt = Number(p.weightKg) || 0;
                    return s + wt * pkg;
                  }, 0);
                  return (
                    <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "var(--c-blue)", textAlign: "right" }}>
                      合计：总体积 {totalVol.toFixed(4)}m³  |  总重量 {totalWt.toFixed(2)}kg
                    </div>
                  );
                })()}
                <button type="button" onClick={() => setFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", domesticTrackingNo: "" }])} style={{ border: "1px dashed var(--c-blue)", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: 4 }}>
                输入长宽高和箱/袋数后，体积自动计算（长×宽×高÷1,000,000×箱数）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <input type="number" min={0} step="0.01" value={form.lengthCm} onChange={(e) => updateOrderDimensions({ lengthCm: e.target.value })} placeholder="长（cm）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" min={0} step="0.01" value={form.widthCm} onChange={(e) => updateOrderDimensions({ widthCm: e.target.value })} placeholder="宽（cm）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" min={0} step="0.01" value={form.heightCm} onChange={(e) => updateOrderDimensions({ heightCm: e.target.value })} placeholder="高（cm）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                <select value={form.packageUnit} onChange={(e) => setForm((v) => ({ ...v, packageUnit: e.target.value as "bag"  |  "box" }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                  <option value="box">箱</option>
                  <option value="bag">袋</option>
                </select>
                <input type="number" value={form.packageCount} onChange={(e) => updateOrderDimensions({ packageCount: e.target.value })} placeholder="箱/袋数" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" step="0.001" value={form.volumeM3} readOnly={formProducts.length > 0} onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="总体积（m³）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" step="0.01" value={form.weightKg ?? ""} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="总重量(kg)" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              </div>
              <input value={form.trackingNo ?? ""} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="预报单号（留空自动生成）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <input value={form.domesticTrackingNo} onChange={(e) => setForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="国内快递单号" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <select value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value as "sea"  |  "land" }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                <option value="">运输方式 *</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              


            </div>
            {/* 产品图片上传 */}
            <div style={{ marginTop: 10, border: "1px dashed var(--l-strong)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--t-strong)" }}>产品图片（可选，可多选）</div>
              <input type="file" multiple accept="image/*" onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setPrealertImageFiles(files);
                setPrealertImagePreviews(files.map(f => URL.createObjectURL(f)));
              }} style={{ fontSize: 12 }} />
              {prealertImagePreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {prealertImagePreviews.map((url, i) => (
                    <div key={i} style={{ position: "relative" }}>
                      <img src={url} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 4, border: "1px solid var(--l-soft)" }} />
                      <button type="button" onClick={() => {
                        setPrealertImageFiles(f => f.filter((_, j) => j !== i));
                        setPrealertImagePreviews(p => p.filter((_, j) => j !== i));
                      }} style={{ position: "absolute", top: -6, right: -6, border: "1px solid #fca5a5", borderRadius: 10, width: 18, height: 18, fontSize: 10, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowCreateModal(false); setPrealertImageFiles([]); setPrealertImagePreviews([]); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}>取消</button>
              <button type="button" onClick={async () => {
                const hasProducts = formProducts.length > 0 && formProducts.some((p) => p.itemName.trim());
                if (!hasProducts && !form.itemName) { setToast("请填写品名"); return; }
                if (!form.transportMode || !form.warehouseId) { setToast("请填写必填项"); return; }
                // ⚠️ 箱数没填就得让客户补，不能悄悄当成 1 箱（2026-08-29 补）
                if (hasProducts) {
                  const rowIssue = validateProductRows(formProducts.filter((p) => p.itemName.trim()));
                  if (rowIssue) { setToast(rowIssue); return; }
                }
                try {
                  const payload: any = { ...form, packageCount: +form.packageCount || 0, weightKg: form.weightKg ? +form.weightKg : undefined, volumeM3: form.volumeM3 ? +form.volumeM3 : undefined, transportMode: form.transportMode as "sea"  |  "land", trackingNo: form.trackingNo?.trim() || undefined };
                  if (hasProducts) {
                    payload.products = formProducts.filter((p) => p.itemName.trim()).map((p) => ({ itemName: p.itemName.trim(), packageCount: packageCountForPayload(p.packageCount), lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined, widthCm: p.widthCm ? Number(p.widthCm) : undefined, heightCm: p.heightCm ? Number(p.heightCm) : undefined, productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined, weightKg: p.weightKg ? Number(p.weightKg) : undefined, domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", cargoType: "normal" }));
                    payload.itemName = payload.products[0].itemName;
                  }
                  const result = await createClientPrealert(payload);
                  // Upload images
                  if (prealertImageFiles.length > 0) {
                    for (const file of prealertImageFiles) {
                      try {
                        const base64 = await new Promise<string>((resolve) => {
                          const reader = new FileReader();
                          reader.onload = () => resolve((reader.result as string).split(",")[1]);
                          reader.readAsDataURL(file);
                        });
                        await uploadStaffOrderProductImage({ orderId: result.prealertId, fileName: file.name, mime: file.type || "image/jpeg", contentBase64: base64 });
                      } catch { /* skip */ }
                    }
                  }
                  setToast("预报单创建成功");
                  setShowCreateModal(false);
                  setForm({ warehouseId: "", itemName: "", packageCount: "", packageUnit: "box" as "bag"  |  "box", lengthCm: "", widthCm: "", heightCm: "", weightKg: "", volumeM3: "", trackingNo: "", domesticTrackingNo: "", transportMode: "" as ""  |  "sea"  |  "land", receiverNameTh: "", receiverPhoneTh: "", receiverAddressTh: "" });
                  setFormProducts([]);
                  setPrealertImageFiles([]);
                  setPrealertImagePreviews([]);
                  await refreshMainData();
                } catch { setToast("创建失败"); }
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, cursor: "pointer" }}>
                提交
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-08-31（条目48）：原来这里有个完整的「编辑预报单」弹窗，
          但 2026-06-28 列表改版后页面上就没有任何按钮能打开它，纯死代码，已删。 */}
      <Toast open={toast.length > 0} message={toast} />
      <section id="client-fcl" style={{ display: activeSection === "client-fcl" ? "block" : "none" }}>
        <FclInquiryPanel visible={activeSection === "client-fcl"} onToast={setToast} />
      </section>
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
          }}
        >
          <img
            src={previewImage.src}
            alt={previewImage.alt}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
          />
        </div>
      )}
    </RoleShell>
  );
}
