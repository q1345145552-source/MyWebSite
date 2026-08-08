"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { apiBaseUrl, apiRequest } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";
import { base64Bytes, compressImageForUpload, formatBytes } from "../../../modules/shared/image-compress";

// 选文件时的原图上限。超过这个的多半是选错了（视频/超大扫描件），先挡掉再说。
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
// 压缩之后单张仍然不许超过这个（后端 MAX_IMAGE_BASE64_LENGTH 是 8MB，这里留足余量）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 一次「保存全部」会把多款货品的图片一起发出去，整个请求体的上限。
// 真正的天花板是 10 MiB —— 不是 nginx 也不是后端，是中间 Next.js 转发那一跳的硬限制
// （2026-08-08 实测：10.4MB 还通，10.8MB 就变成一句光秃秃的 500）。
// 这里取 8MB，给 JSON 里的其他字段和 base64 的换算误差留足余量。
const MAX_UPLOAD_TOTAL_BYTES = 8 * 1024 * 1024;

const jsonPost = { "Content-Type": "application/json" } as const;

// ============================================================================
// 状态中文
// ============================================================================
const STATUS_ZH: Record<string, string> = {
  pending: "待签收",
  received_pending_payment: "待付款",
  payment_submitted: "待审核",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
};
const ST_TAG: Record<string, { bg: string; color: string }> = {
  pending: { bg: "#dbeafe", color: "#1e40af" },
  received_pending_payment: { bg: "#fef3c7", color: "#92400e" },
  payment_submitted: { bg: "#dbeafe", color: "#1e40af" },
  paid: { bg: "#d1fae5", color: "#065f46" },
  loading: { bg: "#ede9fe", color: "#5b21b6" },
  shipped: { bg: "#e0e7ff", color: "#3730a3" },
  thailand_received: { bg: "#d1fae5", color: "#065f46" },
  cancelled: { bg: "#fee2e2", color: "#991b1b" },
};

// ============================================================================
// 类型
// ============================================================================
interface MyPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; usedVolumeM3: number;
  myTotalVolumeM3: number; myTotalFee: number | null;
  myUnitPriceNormal: number; myUnitPriceInspection: number; myUnitPriceSensitive: number;
  prealertCount: number; cancelledCount?: number; latestStatus: string;
  deliveryAddress: string | null;
  createdAt: string;
}

interface ItemRow {
  id: string; productName: string; packageCount: number; quantityPerBox: number;
  totalQuantity: number; unitWeightKg: number | null; totalWeightKg: number | null;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  volumeM3: number | null; material: string; cargoValue: string; cargoType: string;
  productImageFileName: string | null; productImageBase64: string | null; sortOrder: number;
}
interface PrealertRow {
  id: string; trackingNo: string; expressNo: string | null; mark: string;
  status: string; receivedAt: string | null; signedAt: string | null;
  warehouseReceiptProofs: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[];
  totalFee: number | null;
  feeBreakdown?: FeeBreakdown | null;
  paymentProofs: { fileName?: string; mime?: string; base64Path?: string; uploadedAt?: string }[];
  paymentProofUploadedAt: string | null;
  paymentReviewedAt: string | null; paymentRejectReason: string | null;
  thailandReceiptProofs: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[];
  thailandReceivedAt: string | null;
  cancelReason?: string | null; cancelledAt?: string | null;
  createdAt: string; items: ItemRow[];
}
interface MyDetail {
  customerId: string; customerName: string; customerPhone: string;
  unitPriceNormal: number; unitPriceInspection: number; unitPriceSensitive: number;
  totalVolumeM3: number; totalFee: number | null;
  feeBreakdown?: FeeBreakdown | null;
  deliveryAddress: string | null;
  totalPrealerts: number; totalPackages: number;
  prealerts: PrealertRow[];
  statusLogs: { id: string; trackingNo?: string; operatorName: string; operatorRole: string; fromStatus: string; toStatus: string; remark: string | null; createdAt: string }[];
}

// 货品表单行
interface ProductFormRow {
  productName: string; packageCount: string; quantityPerBox: string;
  lengthCm: string; widthCm: string; heightCm: string; unitWeightKg: string;
  material: string; cargoValue: string; cargoType: string;
  imageFile?: { fileName: string; mime: string; base64: string };
  /** 已有图片的服务端路径（/images/xxx），保存时原样回传，后端据此保留原图 */
  existingImageBase64?: string;
}

// 费用明细（后端算好下发，保证和结算口径一致）
interface FeeBreakdownRow {
  cargoType: string; label: string; volumeM3: number; unitPrice: number; amount: number;
}
interface FeeBreakdown {
  rows: FeeBreakdownRow[];
  totalVolumeM3: number;
  computedFee: number;
  storedFee: number | null;
  matchesStored: boolean;
}

const money = (n: number) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 总费用的详细算式：每档「方数 × 单价 = 金额」，最后合计 */
function FeeBreakdownPanel({ bd, title = "费用明细", compact }: { bd?: FeeBreakdown | null; title?: string; compact?: boolean }) {
  if (!bd || !bd.rows || bd.rows.length === 0) return null;
  const fs = compact ? 11 : 12;
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: compact ? "6px 8px" : "8px 10px", fontSize: fs }}>
      <div style={{ fontWeight: 600, color: "#374151", marginBottom: 4 }}>{title}</div>
      {bd.rows.map(r => (
        <div key={r.cargoType} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#4b5563", padding: "1px 0" }}>
          <span>{r.label}：{r.volumeM3.toFixed(3)} 方 × {r.unitPrice} 元/方</span>
          <span style={{ whiteSpace: "nowrap" }}>= {money(r.amount)}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 4, paddingTop: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "#6b7280" }}>合计 {bd.totalVolumeM3.toFixed(3)} 方</span>
        <span style={{ fontWeight: 700, fontSize: fs + 2, color: "#059669", whiteSpace: "nowrap" }}>
          {money(bd.storedFee ?? bd.computedFee)}
        </span>
      </div>
      {!bd.matchesStored && bd.storedFee != null && (
        <div style={{ marginTop: 4, color: "#b45309", fontSize: fs - 1 }}>
          单价在本单结算后有过调整，按现价算为 {money(bd.computedFee)}；本单实际应付以签收时锁定的 {money(bd.storedFee)} 为准。
        </div>
      )}
    </div>
  );
}

/** 把接口返回的图片字段（可能是 /images 路径、data URL 或裸 base64）统一成可用的 src */
function toImageSrc(src: unknown, mime?: string): string {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:") || src.startsWith("/") || src.startsWith("http")) return src;
  return `data:${mime || "image/png"};base64,${src}`;
}

// ============================================================================
// 样式
// ============================================================================
const btnBlue: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnGray: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { padding: "8px 18px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const thS: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "6px 8px", fontSize: 12, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };

/**
 * 把已有货品转成表单行。
 *
 * 保存接口是「整单覆盖」语义：提交什么，这张预报单就剩什么。
 * 所以不管是「编辑」还是「添加货品」，弹窗里都必须先带上这张单已有的全部货品，
 * 否则一保存就把之前的顶掉了。
 */
function itemsToFormRows(items: any[]): ProductFormRow[] {
  return (items ?? []).map((it) => ({
    productName: it.productName ?? "",
    packageCount: String(it.packageCount ?? 1),
    quantityPerBox: String(it.quantityPerBox ?? 1),
    lengthCm: String(it.lengthCm ?? ""),
    widthCm: String(it.widthCm ?? ""),
    heightCm: String(it.heightCm ?? ""),
    unitWeightKg: String(it.unitWeightKg ?? ""),
    material: it.material ?? "",
    cargoValue: it.cargoValue ?? "",
    cargoType: it.cargoType ?? "normal",
    existingImageBase64: it.productImageBase64 || undefined,
  }));
}

function emptyItemForm(): ProductFormRow {
  return { productName: "", packageCount: "1", quantityPerBox: "1", lengthCm: "", widthCm: "", heightCm: "", unitWeightKg: "", material: "", cargoValue: "", cargoType: "normal" };
}

function calcItem(item: ProductFormRow) {
  const pkg = Number(item.packageCount) || 1;
  const qpb = Number(item.quantityPerBox) || 1;
  const totalQty = pkg * qpb;
  const uWeight = Number(item.unitWeightKg) || 0;
  const totalWeight = uWeight * totalQty;
  const len = Number(item.lengthCm) || 0;
  const wid = Number(item.widthCm) || 0;
  const hgt = Number(item.heightCm) || 0;
  const vol = len > 0 && wid > 0 && hgt > 0 ? (len * wid * hgt) / 1000000 * pkg : 0;
  return { totalQty, totalWeight, vol };
}

// ============================================================================
// 主页面
// ============================================================================
export default function ClientWhrConsolidationPage() {
  const [plans, setPlans] = useState<MyPlan[]>([]);
  const [detail, setDetail] = useState<MyDetail | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toast, setToast] = useState("");

  // 预览
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // 预报单展开
  const [expandedPrealert, setExpandedPrealert] = useState<string | null>(null);

  // 创建预报单
  const [showCreatePrealert, setShowCreatePrealert] = useState(false);
  const [newMark, setNewMark] = useState("");
  const [newExpressNo, setNewExpressNo] = useState("");
  const [createPSubmitting, setCreatePSubmitting] = useState(false);

  // 货品编辑弹窗（多行模式）
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemForms, setItemForms] = useState<ProductFormRow[]>([emptyItemForm()]);
  const [itemSubmitting, setItemSubmitting] = useState(false);
  // 正在压缩图片的那一行（压的时候把这一行的选图框禁掉，避免连点）
  const [compressingRow, setCompressingRow] = useState<number | null>(null);
  // 弹窗当前编辑的是哪张预报单 —— 不再依赖 expandedPrealert，避免弹窗开着时展开状态变了保存到别的单上
  const [itemFormPrealertId, setItemFormPrealertId] = useState<string | null>(null);
  // 打开弹窗时这张单已有几行货品，用于在弹窗里给出提示
  const [itemFormExistingCount, setItemFormExistingCount] = useState(0);

  /** 打开货品弹窗：始终带上该预报单已有的全部货品；append=true 时末尾再补一行空白 */
  const openItemForm = (prealertId: string, existingItems: any[], append: boolean) => {
    const rows = itemsToFormRows(existingItems);
    setItemFormPrealertId(prealertId);
    setItemFormExistingCount(rows.length);
    setItemForms(append || rows.length === 0 ? [...rows, emptyItemForm()] : rows);
    setShowItemForm(true);
  };

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<{ prealertId: string; itemIdx: number } | null>(null);

  // 地址编辑
  const [editAddress, setEditAddress] = useState(false);
  const [addressVal, setAddressVal] = useState("");
  const [addressSaving, setAddressSaving] = useState(false);

  // 付款上传 — 预报单级别
  const [showPay, setShowPay] = useState(false);
  const [currentPayPrealertId, setCurrentPayPrealertId] = useState<string | null>(null);
  // 集货余额（2026-08-07）：付款直接扣这里的钱
  const [balance, setBalance] = useState(0);
  const [paySubmitting, setPaySubmitting] = useState(false);

  // ==========================================================================
  // 数据加载
  // ==========================================================================
  /** 读集货余额。付款弹窗要用它判断够不够，付完也要刷新。 */
  const loadBalance = useCallback(async () => {
    try {
      const r = await apiRequest<{ balance?: number; accounts?: { currency: string; balance: number }[] }>(
        `${apiBaseUrl()}/client/wallet/overview`
      );
      setBalance(typeof r.balance === "number" ? r.balance : (r.accounts?.find(a => a.currency === "CNY")?.balance ?? 0));
    } catch { setBalance(0); }
  }, []);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ items: MyPlan[] }>(`${apiBaseUrl()}/client/whr-consolidation/plans`);
      setPlans(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载计划列表失败"); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await apiRequest<MyDetail>(
        `${apiBaseUrl()}/client/whr-consolidation/my-detail?planId=${encodeURIComponent(planId)}`
      );
      setDetail(data);
    } catch (e: any) { setToast(e?.message ?? "加载详情失败"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  // Toast 自动消失，避免旧提示一直挂在页面顶部
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ==========================================================================
  // 操作：创建预报单
  // ==========================================================================
  const handleCreatePrealert = async () => {
    if (!selectedPlanId || !newMark.trim()) { setToast("请填写唛头"); return; }
    setCreatePSubmitting(true);
    try {
      const newPrealert = await apiRequest<{ id: string; trackingNo: string }>(
        `${apiBaseUrl()}/client/whr-consolidation/prealerts`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({ planId: selectedPlanId, mark: newMark.trim(), expressNo: newExpressNo.trim() || undefined }),
        }
      );
      setToast(`预报单 ${newPrealert.trackingNo} 创建成功`);
      setShowCreatePrealert(false); setNewMark(""); setNewExpressNo("");
      const newId = newPrealert.id;
      setExpandedPrealert(newId);
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "创建失败"); }
    finally { setCreatePSubmitting(false); }
  };

  // ==========================================================================
  // 操作：保存货品（覆盖式）
  // ==========================================================================
  const handleSaveItems = async (prealertId: string, rows: ProductFormRow[]) => {
    if (!selectedPlanId) return;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.productName.trim()) { setToast(`第${i + 1}行品名为必填`); return; }
      if (!r.packageCount || Number(r.packageCount) <= 0) { setToast(`第${i + 1}行件数必须大于0`); return; }
      if (!r.quantityPerBox || Number(r.quantityPerBox) <= 0) { setToast(`第${i + 1}行每箱数量必须大于0`); return; }
      // 长宽高必填：缺了算不出方数，签收时会按 0 方计费
      const dims: [string, string][] = [["长", r.lengthCm], ["宽", r.widthCm], ["高", r.heightCm]];
      for (const [label, v] of dims) {
        if (!v || !(Number(v) > 0)) { setToast(`第${i + 1}行${label}(cm)必须大于0，否则无法计算方数`); return; }
      }
      if (!r.material.trim()) { setToast(`第${i + 1}行材质为必填`); return; }
      if (!r.cargoValue.trim()) { setToast(`第${i + 1}行货值为必填`); return; }
    }
    // 多款货品的图片是一起发出去的，整批超上限就当场说清楚，
    // 别让请求发出去被服务器挡掉（那样浏览器只会报 413，客户看不懂）
    const totalBytes = rows.reduce((s, r) => s + (r.imageFile ? base64Bytes(r.imageFile.base64) : 0), 0);
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      setToast(`这 ${rows.length} 款货品的图片共 ${formatBytes(totalBytes)}，超过 ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}，请分两次保存`);
      return;
    }
    setItemSubmitting(true);
    try {
      // rows 允许为空数组 —— 代表删掉了最后一件货品，后端会清空该预报单的货品
      await apiRequest<any>(
        `${apiBaseUrl()}/client/whr-consolidation/prealerts/items`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({
            planId: selectedPlanId, prealertId,
            items: rows.map(r => ({
              productName: r.productName.trim(), packageCount: Number(r.packageCount),
              quantityPerBox: Number(r.quantityPerBox) || 1,
              lengthCm: Number(r.lengthCm),
              widthCm: Number(r.widthCm),
              heightCm: Number(r.heightCm),
              unitWeightKg: r.unitWeightKg ? Number(r.unitWeightKg) : undefined,
              material: r.material.trim(), cargoValue: r.cargoValue.trim(),
              cargoType: r.cargoType || "normal",
              imageFileName: r.imageFile?.fileName, imageMime: r.imageFile?.mime, imageBase64: r.imageFile?.base64,
              // 没有重新选图时把原路径带回去，后端据此保留原图（不带就会被清空）
              existingImagePath: r.imageFile ? undefined : r.existingImageBase64,
            })),
          }),
        }
      );
      setToast(rows.length === 0 ? "货品已清空" : "货品保存成功");
      setShowItemForm(false); setItemForms([emptyItemForm()]); setItemFormPrealertId(null); setItemFormExistingCount(0);
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "保存失败"); }
    finally { setItemSubmitting(false); }
  };

  // ==========================================================================
  // 操作：保存收货地址
  // ==========================================================================
  const handleSaveAddress = async () => {
    if (!selectedPlanId || !detail) return;
    if (!addressVal.trim()) { setToast("收货地址为必填"); setAddressSaving(false); return; }
    setAddressSaving(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/client/whr-consolidation/address`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({ planId: selectedPlanId, deliveryAddress: addressVal.trim() }),
        }
      );
      setToast("地址已保存");
      setEditAddress(false);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "保存失败"); }
    finally { setAddressSaving(false); }
  };

  // ==========================================================================
  // 操作：用集货余额付款（预报单级别，2026-08-07 改）
  // 原来是上传付款凭证等审核，现在直接扣余额、当场完成。
  // 不可撤销，所以下单前有一道确认；点错了只能找客服在管理员端撤销。
  // ==========================================================================
  const handlePay = async () => {
    if (!selectedPlanId || !currentPayPrealertId) return;
    const payPa = detail?.prealerts.find(pa => pa.id === currentPayPrealertId);
    const fee = payPa?.totalFee ?? 0;
    if (!(fee > 0)) { setToast("这张预报单还没有计费金额，请联系客服"); return; }
    if (balance < fee) { setToast(`集货余额不足，还差 ¥${(fee - balance).toFixed(2)}，请先去「集货余额」充值`); return; }
    if (!confirm(`确认用集货余额支付 ¥${fee.toFixed(2)}？\n\n此次付款不可撤销，误操作请联系客服。`)) return;
    setPaySubmitting(true);
    try {
      const r = await apiRequest<any>(
        `${apiBaseUrl()}/client/whr-consolidation/pay`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({ planId: selectedPlanId, prealertId: currentPayPrealertId }),
        }
      );
      setToast(r?.message ?? "付款成功");
      setShowPay(false); setCurrentPayPrealertId(null);
      loadBalance();
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "付款失败"); }
    finally { setPaySubmitting(false); }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================
  return (
    <RoleShell allowedRole="client" title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>{toast}</div>
        )}

        {/* ================================================================ */}
        {/* 计划列表 */}
        {/* ================================================================ */}
        <h3 style={{ fontSize: 17, marginBottom: 16 }}>我的拼柜计划</h3>
        {loading ? <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p> :
         plans.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 14 }}>暂无参与的拼柜计划</p> :
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 20 }}>
            <thead><tr style={{ background: "#f9fafb" }}>
              <th style={thS}>计划编号</th><th style={thS}>仓库</th><th style={thS}>柜型</th><th style={thS}>目的地</th>
              <th style={thS}>方数 (已用/总)</th><th style={thS}>预报单</th><th style={thS}>状态</th><th style={thS}>单价</th>
            </tr></thead>
            <tbody>
              {plans.map(p => {
                const isSelected = selectedPlanId === p.planId;
                const usedPct = p.totalVolumeM3 > 0 ? Math.round((p.usedVolumeM3 / p.totalVolumeM3) * 100) : 0;
                const barColor = usedPct >= 100 ? "#10b981" : usedPct >= 85 ? "#f59e0b" : "#2563eb";
                return (
                  <tr key={p.planId} onClick={() => {
                    if (isSelected) { setSelectedPlanId(null); setDetail(null); }
                    else { setSelectedPlanId(p.planId); loadDetail(p.planId); }
                  }} style={{ cursor: "pointer", background: isSelected ? "#eff6ff" : "white" }}
                    onMouseEnter={e => { e.currentTarget.style.background = isSelected ? "white" : "#f9fafb" }}
                    onMouseLeave={e => { e.currentTarget.style.background = isSelected ? "#eff6ff" : "white" }}>
                    <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                    <td style={tdS}>{p.warehouse}</td>
                    <td style={tdS}>{p.containerType}</td>
                    <td style={tdS}>{p.destinationTh}</td>
                    <td style={tdS}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ flex: 1, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden", minWidth: 80 }}>
                          <div style={{ height: "100%", width: `${Math.min(usedPct, 100)}%`, background: barColor, borderRadius: 4, transition: "width 0.3s" }} />
                        </div>
                        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>{p.usedVolumeM3} / {p.totalVolumeM3} 方</span>
                      </div>
                    </td>
                    <td style={tdS}>{p.prealertCount} 个</td>
                    <td style={tdS}>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: ST_TAG[p.latestStatus]?.bg ?? "#e5e7eb", color: ST_TAG[p.latestStatus]?.color ?? "#374151" }}>
                        {STATUS_ZH[p.latestStatus] ?? p.latestStatus}
                      </span>
                    </td>
                    <td style={{ ...tdS, fontSize: 12, color: "#6b7280" }}>
                      普{p.myUnitPriceNormal} · 商{p.myUnitPriceInspection} · 敏{p.myUnitPriceSensitive}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }

        {/* ================================================================ */}
        {/* 详情区 */}
        {/* ================================================================ */}
        {selectedPlanId && detailLoading && <p style={{ color: "#9ca3af", padding: "20px 0" }}>加载详情中...</p>}

        {selectedPlanId && detail && (() => {
          const addressMissing = !detail.deliveryAddress?.trim();
          return (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 20px", background: "#fafafa" }}>
            {/* -------- 客户信息 -------- */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <strong style={{ fontSize: 15 }}>{detail.customerName}</strong>
                <span style={{ fontSize: 13, color: "#6b7280", marginLeft: 8 }}>{detail.customerPhone}</span>
              </div>
              <span style={{ fontSize: 13, color: "#6b7280" }}>{detail.totalVolumeM3}方 · {detail.totalPackages}件 · {detail.totalPrealerts}个预报单</span>
            </div>

            {/* -------- 价格信息 -------- */}
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>
              普货：{detail.unitPriceNormal}元/方 · 商检：{detail.unitPriceInspection}元/方 · 敏感：{detail.unitPriceSensitive}元/方
            </div>

            {/* -------- 总费用及其算式 -------- */}
            {detail.feeBreakdown && detail.feeBreakdown.rows.length > 0 && (
              <div style={{ marginBottom: 12, maxWidth: 460 }}>
                <FeeBreakdownPanel bd={detail.feeBreakdown} title="总费用明细（全部未取消预报单合计）" />
              </div>
            )}

            {/* -------- 收货地址（必填） -------- */}
            <div style={{ marginBottom: 12 }}>
              {editAddress ? (
                <div>
                  <label style={{ ...fl, marginBottom: 4 }}>
                    泰国收货地址 <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      value={addressVal}
                      onChange={e => setAddressVal(e.target.value)}
                      placeholder="请填写详细的泰国收货地址（必填）"
                      style={{ ...fi, maxWidth: 360 }}
                    />
                    <button onClick={handleSaveAddress} disabled={addressSaving || !addressVal.trim()} style={{ ...btnBlue, opacity: addressVal.trim() ? 1 : 0.5, cursor: addressVal.trim() ? "pointer" : "not-allowed" }}>
                      {addressSaving ? "..." : "保存"}
                    </button>
                    {detail.deliveryAddress && <button onClick={() => setEditAddress(false)} style={btnGray}>取消</button>}
                  </div>
                </div>
              ) : addressMissing ? (
                <div style={{ padding: "10px 12px", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#991b1b", marginBottom: 4 }}>
                    请先填写泰国收货地址 <span style={{ color: "#ef4444" }}>*</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#7f1d1d", marginBottom: 8 }}>
                    收货地址是必填项，尾端拆派要用。填写之前无法新建预报单，也无法上传付款凭证。
                  </div>
                  <button onClick={() => { setAddressVal(""); setEditAddress(true); }} style={btnBlue}>立即填写</button>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "#374151" }}>
                  收货地址 <span style={{ color: "#ef4444" }}>*</span>：{detail.deliveryAddress}
                  <button onClick={() => { setAddressVal(detail.deliveryAddress ?? ""); setEditAddress(true); }} style={{ ...btnGray, marginLeft: 8, padding: "3px 12px", fontSize: 12 }}>编辑</button>
                </div>
              )}
            </div>

            {/* -------- 新建预报单按钮（需先填收货地址） -------- */}
            <div style={{ marginBottom: 14 }}>
              <button
                onClick={() => {
                  if (addressMissing) { setToast("请先填写泰国收货地址"); setEditAddress(true); return; }
                  setShowCreatePrealert(true); setNewMark(""); setNewExpressNo("");
                }}
                disabled={addressMissing}
                style={{ ...btnBlue, opacity: addressMissing ? 0.5 : 1, cursor: addressMissing ? "not-allowed" : "pointer" }}
                title={addressMissing ? "请先填写泰国收货地址" : ""}
              >+ 新建预报单</button>
              {addressMissing && <span style={{ fontSize: 12, color: "#ef4444", marginLeft: 8 }}>需先填写收货地址</span>}
            </div>

            {/* ====== 预报单列表 ====== */}
            {detail.prealerts.length === 0 ? (
              <p style={{ fontSize: 13, color: "#9ca3af", padding: "8px 0" }}>暂无预报单，请新建</p>
            ) : (
              detail.prealerts.map(pa => {
                const isExpanded = expandedPrealert === pa.id;
                const isEditing = pa.status === "pending";
                const paItems = pa.items ?? [];
                const paVol = paItems.reduce((s: number, it: ItemRow) => s + (it.volumeM3 ?? 0), 0);
                const paPkg = paItems.reduce((s: number, it: ItemRow) => s + it.packageCount, 0);

                return (
                  <div key={pa.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 12, background: "#fff", overflow: "hidden" }}>
                    {/* 预报单头部 */}
                    <div onClick={() => setExpandedPrealert(isExpanded ? null : pa.id)} style={{ cursor: "pointer", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", background: isExpanded ? "#f0f7ff" : "#fff" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <strong style={{ fontSize: 14 }}>{pa.trackingNo}</strong>
                        <span style={{ fontSize: 12, color: "#6b7280" }}>唛头：{pa.mark || "-"}</span>
                        {pa.expressNo && <span style={{ fontSize: 12, color: "#6b7280" }}>快递：{pa.expressNo}</span>}
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: ST_TAG[pa.status]?.bg ?? "#e5e7eb", color: ST_TAG[pa.status]?.color ?? "#374151" }}>{STATUS_ZH[pa.status] ?? pa.status}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {pa.totalFee != null && <span style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>{money(pa.totalFee)}</span>}
                        <span style={{ fontSize: 12, color: "#9ca3af" }}>{paVol.toFixed(3)}方 · {paItems.length}款 · {paPkg}件 {isExpanded ? "▲" : "▼"}</span>
                      </div>
                    </div>

                    {/* 预报单展开内容 */}
                    {isExpanded && (
                      <div style={{ padding: "10px 14px", borderTop: "1px solid #e5e7eb" }}>
                        {/* --- 已取消提示 --- */}
                        {pa.status === "cancelled" && (
                          <div style={{ padding: "10px 12px", background: "#fee2e2", borderRadius: 6, marginBottom: 10, fontSize: 13, color: "#991b1b" }}>
                            该预报单已取消{pa.cancelReason ? `：${pa.cancelReason}` : ""}
                            {pa.cancelledAt && <span style={{ marginLeft: 8, color: "#6b7280" }}>{formatBeijingTime(pa.cancelledAt)}</span>}
                            <div style={{ marginTop: 4, color: "#6b7280" }}>已释放占用的方数，不再计入本柜和费用。</div>
                          </div>
                        )}

                        {/* --- 付款按钮（此预报单待付款时显示） --- */}
                        {pa.status === "received_pending_payment" && (
                          <div style={{ padding: "10px 12px", background: "#fef3c7", borderRadius: 6, marginBottom: 10 }}>
                            {(pa.paymentProofs?.length ?? 0) > 0 ? (
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 6 }}>已提交 {pa.paymentProofs.length} 张付款凭证，等待审核</div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  {pa.paymentProofs.map((p, i) => {
                                    const imgSrc = toImageSrc(p.base64Path || (p as any).base64, p.mime);
                                    return imgSrc ? <img key={i} src={imgSrc} alt={`付款凭证 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} /> : null;
                                  })}
                                </div>
                                {pa.paymentRejectReason && (
                                  <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>拒绝原因：{pa.paymentRejectReason}<br />请重新上传。</div>
                                )}
                                <button onClick={() => {
                                  if (addressMissing) { setToast("请先填写泰国收货地址"); setEditAddress(true); return; }
                                  setCurrentPayPrealertId(pa.id); setShowPay(true);
                                }} disabled={addressMissing} style={{ ...btnBlue, marginTop: 8, opacity: addressMissing ? 0.5 : 1, cursor: addressMissing ? "not-allowed" : "pointer" }}>重新付款</button>
                              </div>
                            ) : (
                              <div>
                                <div style={{ fontSize: 13, color: "#92400e", fontWeight: 600, marginBottom: 6, textAlign: "center" }}>
                                  待付款 {pa.totalFee != null ? money(pa.totalFee) : "—"}
                                </div>
                                <FeeBreakdownPanel bd={pa.feeBreakdown} title="本单费用是这样算的" />
                                <div style={{ textAlign: "center", marginTop: 8 }}>
                                  <button onClick={() => {
                                    if (addressMissing) { setToast("请先填写泰国收货地址"); setEditAddress(true); return; }
                                    setCurrentPayPrealertId(pa.id); setShowPay(true);
                                  }} disabled={addressMissing} style={{ ...btnBlue, opacity: addressMissing ? 0.5 : 1, cursor: addressMissing ? "not-allowed" : "pointer" }}>用余额付款</button>
                                  {addressMissing && <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>需先填写收货地址才能付款</div>}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* --- 付款状态为待审核时 --- */}
                        {pa.status === "payment_submitted" && (pa.paymentProofs?.length ?? 0) > 0 && (
                          <div style={{ padding: "10px 12px", background: "#dbeafe", borderRadius: 6, marginBottom: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#1e40af", marginBottom: 6 }}>已提交付款凭证，等待审核</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {pa.paymentProofs.map((p, i) => {
                                const imgSrc = toImageSrc(p.base64Path || (p as any).base64, p.mime);
                                return imgSrc ? <img key={i} src={imgSrc} alt={`付款凭证 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} /> : null;
                              })}
                            </div>
                          </div>
                        )}

                        {/* --- 仓库签收凭证 --- */}
                        {(pa.warehouseReceiptProofs ?? []).length > 0 && (
                          <div style={{ padding: "10px 12px", background: "#f0fdf4", borderRadius: 6, marginBottom: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#065f46", marginBottom: 6 }}>仓库已签收（{(pa.warehouseReceiptProofs ?? []).length}张）</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {(pa.warehouseReceiptProofs ?? []).map((pf, i) => (
                                <img key={i} src={pf.base64Path} alt={`收货凭证 ${i+1}`} onClick={() => setPreviewImage(pf.base64Path)} style={{ maxWidth: 150, maxHeight: 100, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* --- 泰国签收单 --- */}
                        {pa.status === "thailand_received" && (pa.thailandReceiptProofs ?? []).length > 0 && (
                          <div style={{ padding: "10px 12px", background: "#d1fae5", borderRadius: 6, marginBottom: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#065f46", marginBottom: 6 }}>泰国已签收（{(pa.thailandReceiptProofs ?? []).length}张）</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {(pa.thailandReceiptProofs ?? []).map((pf, i) => (
                                <img key={i} src={pf.base64Path} alt={`泰国签收单 ${i+1}`} onClick={() => setPreviewImage(pf.base64Path)} style={{ maxWidth: "100%", maxHeight: 250, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                              ))}
                            </div>
                            {pa.thailandReceivedAt && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>签收时间：{formatBeijingTime(pa.thailandReceivedAt)}</div>}
                          </div>
                        )}

                        {/* --- 费用明细（待付款那块已经单独展示过，这里给其余状态用） --- */}
                        {pa.status !== "received_pending_payment" && pa.status !== "cancelled" && pa.feeBreakdown && pa.feeBreakdown.rows.length > 0 && (
                          <div style={{ marginBottom: 10, maxWidth: 420 }}>
                            <FeeBreakdownPanel bd={pa.feeBreakdown} title="本单费用明细" />
                          </div>
                        )}

                        {/* --- 货品表格 --- */}
                        {paItems.length > 0 ? (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                              <thead><tr style={{ background: "#f3f4f6" }}>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>品名</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>件数</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>每箱</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>总数</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>单重</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>总重</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>长</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>宽</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>高</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>方数</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>材质</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>货值</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>类型</th>
                                <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>图片</th>
                                {isEditing && <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>操作</th>}
                              </tr></thead>
                              <tbody>
                                {paItems.map((it: any, i: number) => (
                                  <tr key={it.id ?? i}>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.quantityPerBox}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalQuantity}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.unitWeightKg ?? "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalWeightKg ?? "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.lengthCm ?? "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.widthCm ?? "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.heightCm ?? "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(3) : "-"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.material}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoValue}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                    <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>
                                      {it.productImageBase64
                                        ? <button onClick={() => setPreviewImage(it.productImageBase64)} style={{ ...btnGray, padding: "2px 8px", fontSize: 11 }}>查看图片</button>
                                        : <span style={{ color: "#d1d5db" }}>—</span>}
                                    </td>
                                    {isEditing && (
                                      <td style={{ ...tdS, padding: "3px 6px", fontSize: 11, whiteSpace: "nowrap" }}>
                                        <button onClick={() => openItemForm(pa.id, paItems, false)} style={{ ...btnGray, padding: "2px 8px", fontSize: 11, marginRight: 4 }}>编辑</button>
                                        <button onClick={() => setDeleteTarget({ prealertId: pa.id, itemIdx: i })} style={{ ...btnDanger, padding: "2px 8px", fontSize: 11 }}>删除</button>
                                      </td>
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div style={{ padding: "10px 0" }}>
                            <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>暂无货品</p>
                          </div>
                        )}

                        {/* 添加货品按钮 */}
                        {isEditing && (
                          <div style={{ padding: "6px 0 4px" }}>
                            <button onClick={() => openItemForm(pa.id, paItems, true)} style={btnBlue}>+ 添加货品</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* ====== 状态时间线 ====== */}
            {detail.statusLogs.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 10 }}>状态时间线</div>
                {detail.statusLogs.map(sl => (
                  <div key={sl.id} style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid #e5e7eb" }}>
                    {sl.trackingNo && <strong style={{ color: "#2563eb", marginRight: 6 }}>{sl.trackingNo}</strong>}
                    <strong style={{ color: "#374151" }}>{STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</strong> → <strong style={{ color: "#374151" }}>{STATUS_ZH[sl.toStatus] ?? sl.toStatus}</strong>
                    &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                    {sl.remark && <div style={{ color: "#9ca3af", marginTop: 2 }}>{sl.remark}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：新建预报单 */}
        {/* ================================================================ */}
        {showCreatePrealert && (
          <Modal onClose={() => setShowCreatePrealert(false)}>
            <h3 style={{ marginTop: 0 }}>新建预报单</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div><label style={fl}>唛头 *</label><input value={newMark} onChange={e => setNewMark(e.target.value)} placeholder="必填" style={fi} /></div>
              <div><label style={fl}>快递单号（可选）</label><input value={newExpressNo} onChange={e => setNewExpressNo(e.target.value)} placeholder="可选" style={fi} /></div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCreatePrealert} disabled={createPSubmitting} style={btnBlue}>{createPSubmitting ? "提交中..." : "确认创建"}</button>
              <button onClick={() => setShowCreatePrealert(false)} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：编辑货品（多行模式） */}
        {/* ================================================================ */}
        {showItemForm && (
          <Modal wide onClose={() => { setShowItemForm(false); setItemFormPrealertId(null); }}>
            <h3 style={{ marginTop: 0 }}>
              货品清单
              {itemFormPrealertId && (
                <span style={{ fontSize: 13, fontWeight: 400, color: "#6b7280", marginLeft: 8 }}>
                  {detail?.prealerts.find(p => p.id === itemFormPrealertId)?.trackingNo ?? ""}
                </span>
              )}
            </h3>
            <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
              这里是该预报单的<strong>完整</strong>货品清单
              {itemFormExistingCount > 0 && `（已有 ${itemFormExistingCount} 款，本次共 ${itemForms.length} 款）`}
              。点「保存全部」后，这张预报单的货品就以下面的列表为准；在这里删掉的行会被真正删除。
            </div>
            <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
              {itemForms.map((row, idx) => {
                const { totalQty, totalWeight, vol } = calcItem(row);
                return (
                  <div key={idx} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 10, marginBottom: 10, background: "#fafafa" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <strong style={{ fontSize: 13 }}>
                        产品 {idx + 1}
                        {idx < itemFormExistingCount
                          ? <span style={{ fontSize: 11, fontWeight: 400, color: "#6b7280", marginLeft: 6 }}>已有</span>
                          : <span style={{ fontSize: 11, fontWeight: 400, color: "#059669", marginLeft: 6 }}>新增</span>}
                      </strong>
                      <button onClick={() => setItemForms(itemForms.filter((_, i) => i !== idx))} style={{ ...btnDanger, padding: "2px 10px", fontSize: 11 }}>移除</button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>品名</label><input value={row.productName} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], productName: e.target.value }; setItemForms(cp); }} placeholder="品名 *" style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>件数</label><input type="number" value={row.packageCount} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], packageCount: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>每箱数量</label><input type="number" value={row.quantityPerBox} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], quantityPerBox: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>单件重量(kg)</label><input type="number" value={row.unitWeightKg} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], unitWeightKg: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>长(cm)</label><input type="number" value={row.lengthCm} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], lengthCm: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>宽(cm)</label><input type="number" value={row.widthCm} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], widthCm: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>高(cm)</label><input type="number" value={row.heightCm} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], heightCm: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>材质</label><input value={row.material} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], material: e.target.value }; setItemForms(cp); }} placeholder="材质 *" style={{ ...fi, marginTop: 2 }} /></div>
                      <div><label style={{ fontSize: 11, color: "#6b7280" }}>货值</label><input value={row.cargoValue} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], cargoValue: e.target.value }; setItemForms(cp); }} placeholder="货值 *" style={{ ...fi, marginTop: 2 }} /></div>
                      <div>
                        <label style={{ fontSize: 11, color: "#6b7280" }}>类型</label>
                        <select value={row.cargoType} onChange={e => { const cp = [...itemForms]; cp[idx] = { ...cp[idx], cargoType: e.target.value }; setItemForms(cp); }} style={{ ...fi, marginTop: 2 }}>
                          <option value="normal">普货</option>
                          <option value="inspection">商检</option>
                          <option value="sensitive">敏感</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
                      总数：{totalQty} 件 · 总重：{totalWeight.toFixed(2)} kg · 方数：{vol.toFixed(3)} m³
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <label style={{ fontSize: 11, color: "#6b7280" }}>产品图片</label>
                      {row.existingImageBase64 && (
                        <div style={{ marginTop: 2, marginBottom: 4 }}>
                          <img src={row.existingImageBase64} alt="已有图片" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                        </div>
                      )}
                      <input type="file" accept="image/*" disabled={compressingRow === idx} onChange={async e => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        if (file.size > MAX_SOURCE_BYTES) {
                          setToast(`图片 ${file.name} 有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_SOURCE_BYTES)}，请换一张`);
                          return;
                        }
                        setCompressingRow(idx);
                        try {
                          const img = await compressImageForUpload(file);
                          if (base64Bytes(img.base64) > MAX_IMAGE_BYTES) {
                            setToast(`图片 ${file.name} 压缩后仍有 ${formatBytes(base64Bytes(img.base64))}，请换一张`);
                            return;
                          }
                          setItemForms(prev => prev.map((row, i) => (
                            i === idx ? { ...row, imageFile: img, existingImageBase64: undefined } : row
                          )));
                        } finally { setCompressingRow(null); }
                      }} style={{ marginTop: 2 }} />
                      {compressingRow === idx && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>正在处理图片，请稍候…</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            {itemForms.length === 0 && (
              <p style={{ fontSize: 13, color: "#ef4444", padding: "8px 0" }}>当前清单为空，保存后这张预报单的货品会被全部清空。</p>
            )}
            <div style={{ marginTop: 12, marginBottom: 14 }}>
              <button onClick={() => setItemForms([...itemForms, emptyItemForm()])} style={{ ...btnGray, fontSize: 12 }}>+ 添加一行</button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => {
                if (!itemFormPrealertId) { setToast("请先选择预报单"); return; }
                handleSaveItems(itemFormPrealertId, itemForms);
              }} disabled={itemSubmitting} style={btnBlue}>{itemSubmitting ? "保存中..." : `保存全部（${itemForms.length} 款）`}</button>
              <button onClick={() => { setShowItemForm(false); setItemFormPrealertId(null); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：付款上传（预报单级别） */}
        {/* ================================================================ */}
        {showPay && (() => {
          const payPa = detail?.prealerts.find(pa => pa.id === currentPayPrealertId);
          const fee = payPa?.totalFee ?? 0;
          const enough = balance >= fee && fee > 0;
          return (
          <Modal onClose={() => { setShowPay(false); setCurrentPayPrealertId(null); }}>
            <h3 style={{ marginTop: 0 }}>用集货余额付款</h3>
            <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>
              预报单：{payPa?.trackingNo ?? "—"}
              &nbsp;· 应付：<strong style={{ color: "#1e3a8a", fontSize: 16 }}>{fee > 0 ? money(fee) : "—"}</strong>
            </p>
            <FeeBreakdownPanel bd={payPa?.feeBreakdown} title="费用是这样算出来的" />
            <p style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>收货地址：{detail?.deliveryAddress || "未填写"}</p>

            <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 6 }}>
              <div style={{ fontSize: 13 }}>当前集货余额：<strong>¥{balance.toFixed(2)}</strong></div>
              {fee > 0 && (
                enough
                  ? <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>付款后剩余：¥{(balance - fee).toFixed(2)}</div>
                  : <div style={{ fontSize: 13, color: "#b91c1c", marginTop: 4 }}>余额不足，还差 ¥{(fee - balance).toFixed(2)}，请先去「集货余额」充值</div>
              )}
            </div>

            {/* 不可撤销必须写清楚 —— 扣款是当场生效的 */}
            <p style={{ fontSize: 13, color: "#b91c1c", marginTop: 12, fontWeight: 600 }}>
              此次付款不可撤销，误操作请联系客服
            </p>

            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handlePay} disabled={paySubmitting || !enough} style={{ ...btnBlue, opacity: enough ? 1 : 0.5, cursor: enough ? "pointer" : "not-allowed" }}>
                {paySubmitting ? "付款中..." : "确认付款"}
              </button>
              <button onClick={() => { setShowPay(false); setCurrentPayPrealertId(null); }} style={btnGray}>取消</button>
            </div>
          </Modal>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：删除确认 */}
        {/* ================================================================ */}
        {deleteTarget && (() => {
          // 以 deleteTarget.prealertId 为准，不依赖当前展开的是哪张单
          const targetPa = detail?.prealerts.find(p => p.id === deleteTarget.prealertId);
          const targetItems = targetPa?.items ?? [];
          const targetItem = targetItems[deleteTarget.itemIdx];
          return (
            <Modal onClose={() => setDeleteTarget(null)}>
              <p style={{ marginTop: 0 }}>
                确定删除货品「{targetItem?.productName ?? "-"}」吗？
              </p>
              <p style={{ fontSize: 12, color: "#6b7280", marginTop: 0 }}>
                预报单 {targetPa?.trackingNo ?? "-"} 删除后将剩余 {Math.max(targetItems.length - 1, 0)} 款货品。
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => {
                  // 保留其余行的已有图片路径，否则删一件会把整单的产品图片全部清空
                  const filtered: ProductFormRow[] = itemsToFormRows(
                    targetItems.filter((_, i) => i !== deleteTarget.itemIdx)
                  );
                  const paId = deleteTarget.prealertId;
                  setDeleteTarget(null);
                  // filtered 可能为空数组（删的是最后一件），后端已支持清空
                  handleSaveItems(paId, filtered);
                }} style={btnDanger}>确认删除</button>
                <button onClick={() => setDeleteTarget(null)} style={btnGray}>取消</button>
              </div>
            </Modal>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：图片预览 */}
        {/* ================================================================ */}
        {previewImage && (
          <div onClick={() => setPreviewImage(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src={previewImage} alt="预览" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
          </div>
        )}
      </div>
    </RoleShell>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: wide ? 700 : 480, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
