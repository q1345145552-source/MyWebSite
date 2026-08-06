"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { apiBaseUrl, apiRequest } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

const jsonPost = { "Content-Type": "application/json" } as const;

// 费用明细（后端算好下发，保证三端口径一致）
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
          结算后调过单价：按现价算为 {money(bd.computedFee)}，实际应付以锁定的 {money(bd.storedFee)} 为准。
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

interface StatusLogRow {
  id: string;
  operatorName: string;
  operatorRole: string;
  fromStatus: string;
  toStatus: string;
  remark: string | null;
  createdAt: string;
}

/** 客户级时间线由所有预报单的日志聚合而成（后端不再重复下发一份） */
function aggregateCustomerLogs(prealerts: { trackingNo: string; statusLogs?: StatusLogRow[] }[]) {
  return prealerts
    .flatMap((pa) => (pa.statusLogs ?? []).map((sl) => ({ ...sl, trackingNo: pa.trackingNo })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200);
}

// ============================================================================
// 状态中文映射 & 标签颜色
// ============================================================================
const PLAN_STATUS_ZH: Record<string, string> = {
  planning: "计划中",
  collecting: "集货中",
  loading: "装柜中",
  shipped: "已发运",
  completed: "已完成",
  cancelled: "已取消",
};
const PREALERT_STATUS_ZH: Record<string, string> = {
  pending: "待签收",
  received_pending_payment: "待付款",
  payment_submitted: "待审核",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
  planning: { bg: "#e0e7ff", color: "#3730a3" },
  collecting: { bg: "#dbeafe", color: "#1e40af" },
  loading: { bg: "#ede9fe", color: "#5b21b6" },
  shipped: { bg: "#e0e7ff", color: "#3730a3" },
  completed: { bg: "#d1fae5", color: "#065f46" },
  cancelled: { bg: "#fee2e2", color: "#991b1b" },
  pending: { bg: "#fef3c7", color: "#92400e" },
  received_pending_payment: { bg: "#fef3c7", color: "#92400e" },
  payment_submitted: { bg: "#dbeafe", color: "#1e40af" },
  paid: { bg: "#d1fae5", color: "#065f46" },
  thailand_received: { bg: "#d1fae5", color: "#065f46" },
};

// ============================================================================
// 类型定义
// ============================================================================
interface PlanItem {
  id: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  totalVolumeM3: number;
  status: string;
  creatorName: string;
  customerCount: number;
  createdAt: string;
}

interface PrealertItem {
  id: string;
  trackingNo: string;
  expressNo: string | null;
  mark: string;
  status: string;
  receivedAt: string | null;
  signedAt?: string | null;
  warehouseReceiptBase64?: string | null;
  totalFee?: number | null;
  feeBreakdown?: FeeBreakdown | null;
  paymentProofs?: { fileName?: string; mime?: string; base64Path?: string; base64?: string; uploadedAt?: string }[];
  paymentProofUploadedAt?: string | null;
  paymentReviewedAt?: string | null;
  paymentRejectReason?: string | null;
  thailandReceiptBase64?: string | null;
  thailandReceivedAt?: string | null;
  createdAt: string;
  items: {
    id: string;
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    totalQuantity: number;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
    unitWeightKg: number | null;
    totalWeightKg: number | null;
    volumeM3: number | null;
    material: string;
    cargoValue: string;
    cargoType: string;
    productImageFileName: string | null;
    productImageBase64: string | null;
    sortOrder: number;
  }[];
  statusLogs?: {
    id: string;
    operatorName: string;
    operatorRole: string;
    fromStatus: string;
    toStatus: string;
    remark: string | null;
    createdAt: string;
  }[];
}

interface CustomerDetail {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  clientCompany: string;
  unitPriceNormal: number;
  unitPriceInspection: number;
  unitPriceSensitive: number;
  totalVolumeM3: number;
  totalFee: number | null;
  feeBreakdown?: FeeBreakdown | null;
  deliveryAddress: string | null;
  totalPrealerts: number;
  totalPackages: number;
  totalItems: number;
  prealerts: PrealertItem[];
}

interface PlanDetail {
  id: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  totalVolumeM3: number;
  usedVolumeM3?: number;
  status: string;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  customers: CustomerDetail[];
}

interface ClientOption {
  id: string;
  name: string;
  phone: string;
  companyName: string | null;
  status?: string | null;
}

interface CreateCustomerForm {
  clientId: string;
  unitPriceNormal: string;
  unitPriceInspection: string;
  unitPriceSensitive: string;
}

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };
const btnConfirm: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnCancel: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { padding: "8px 18px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

// ============================================================================
// 主页面
// ============================================================================
export default function AdminWhrConsolidationPage() {
  // --- 列表 ---
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  // --- 详情 ---
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [expandedPrealert, setExpandedPrealert] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // --- 新建计划 ---
  const [showCreate, setShowCreate] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [newWarehouse, setNewWarehouse] = useState("义乌");
  const [newContainerType, setNewContainerType] = useState("40HQ");
  const [newDestinationTh, setNewDestinationTh] = useState("");
  const [newTotalVolume, setNewTotalVolume] = useState("68");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientSearch, setClientSearch] = useState("");
  const [selectedCustomers, setSelectedCustomers] = useState<CreateCustomerForm[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  // --- 审核（预报单级别） ---
  const [reviewTarget, setReviewTarget] = useState<{ planId: string; prealert: PrealertItem } | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectPriceNormal, setRejectPriceNormal] = useState("");
  const [rejectPriceInspection, setRejectPriceInspection] = useState("");
  const [rejectPriceSensitive, setRejectPriceSensitive] = useState("");

  // --- 取消（预报单级别） ---
  const [cancelTarget, setCancelTarget] = useState<{ planId: string; prealert: PrealertItem } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // --- 改单价 ---
  const [priceTarget, setPriceTarget] = useState<CustomerDetail | null>(null);
  // 新增 / 移除参与客户（2026-08-07）
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [addClientId, setAddClientId] = useState("");
  const [addSearch, setAddSearch] = useState("");
  const [addPriceNormal, setAddPriceNormal] = useState("");
  const [addPriceInspection, setAddPriceInspection] = useState("");
  const [addPriceSensitive, setAddPriceSensitive] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [removingCustomerId, setRemovingCustomerId] = useState("");
  const [editPriceNormal, setEditPriceNormal] = useState("");
  const [editPriceInspection, setEditPriceInspection] = useState("");
  const [editPriceSensitive, setEditPriceSensitive] = useState("");
  const [priceSubmitting, setPriceSubmitting] = useState(false);

  // ==========================================================================
  // 数据加载
  // ==========================================================================
  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ items: PlanItem[] }>(`${apiBaseUrl()}/admin/whr-consolidation/plans`);
      setPlans(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载计划列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await apiRequest<PlanDetail>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`
      );
      setPlanDetail(data);
    } catch (e: any) {
      setToast(e?.message ?? "加载详情失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // /admin/users 不支持 search / pageSize 参数（传了会被忽略），所以这里一次性拉回列表，
  // 过滤放到前端做，搜索框才是真的有用
  const loadClients = useCallback(async () => {
    setClientsLoading(true);
    try {
      const data = await apiRequest<{ items: ClientOption[] }>(`${apiBaseUrl()}/admin/users?role=client`);
      setClients(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载客户列表失败");
    } finally {
      setClientsLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // 客户搜索：本地按姓名/电话/公司过滤，已选中的始终保留在列表里
  const filteredClients = (() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (cl) =>
        selectedCustomers.some((sc) => sc.clientId === cl.id) ||
        (cl.name ?? "").toLowerCase().includes(q) ||
        (cl.phone ?? "").toLowerCase().includes(q) ||
        (cl.companyName ?? "").toLowerCase().includes(q),
    );
  })();

  // ==========================================================================
  // 操作函数
  // ==========================================================================
  const handleCreate = async () => {
    if (!newDestinationTh.trim()) { setToast("请输入目的地"); return; }
    if (selectedCustomers.length === 0) { setToast("请至少选择一位客户"); return; }
    for (let i = 0; i < selectedCustomers.length; i++) {
      const c = selectedCustomers[i];
      if (!c.unitPriceNormal || Number(c.unitPriceNormal) <= 0) { setToast(`第${i + 1}位客户普货单价必须大于0`); return; }
      if (!c.unitPriceInspection || Number(c.unitPriceInspection) <= 0) { setToast(`第${i + 1}位客户商检单价必须大于0`); return; }
      if (!c.unitPriceSensitive || Number(c.unitPriceSensitive) <= 0) { setToast(`第${i + 1}位客户敏感货单价必须大于0`); return; }
    }
    setCreateSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            warehouse: newWarehouse,
            containerType: newContainerType,
            destinationTh: newDestinationTh.trim(),
            totalVolumeM3: Number(newTotalVolume) || 68,
            customers: selectedCustomers.map(c => ({
              clientId: c.clientId,
              unitPriceNormal: Number(c.unitPriceNormal),
              unitPriceInspection: Number(c.unitPriceInspection),
              unitPriceSensitive: Number(c.unitPriceSensitive),
            })),
          }),
        }
      );
      setToast("计划创建成功");
      setShowCreate(false);
      setNewDestinationTh("");
      setNewWarehouse("义乌");
      setNewContainerType("40HQ");
      setNewTotalVolume("68");
      setSelectedCustomers([]);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "创建失败"); }
    finally { setCreateSubmitting(false); }
  };

  const handleApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({ planId: reviewTarget.planId, prealertId: reviewTarget.prealert.id, action: "approve" }),
        }
      );
      setToast("审核通过");
      setReviewTarget(null);
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "审核失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      const r = await apiRequest<{ totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            planId: reviewTarget.planId,
            prealertId: reviewTarget.prealert.id,
            action: "reject",
            rejectReason: rejectReason.trim(),
            unitPriceNormal: rejectPriceNormal ? Number(rejectPriceNormal) : undefined,
            unitPriceInspection: rejectPriceInspection ? Number(rejectPriceInspection) : undefined,
            unitPriceSensitive: rejectPriceSensitive ? Number(rejectPriceSensitive) : undefined,
          }),
        }
      );
      setToast(r?.totalFee != null ? `已拒绝，应付金额已更新为 ¥${r.totalFee}` : "已拒绝");
      setShowReject(false); setReviewTarget(null); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) { setToast("请填写取消原因"); return; }
    setCancelSubmitting(true);
    try {
      const r = await apiRequest<{ customerVolume?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/cancel`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({ planId: cancelTarget.planId, prealertId: cancelTarget.prealert.id, cancelReason: cancelReason.trim() }),
        }
      );
      setToast(r?.customerVolume != null ? `已取消，该客户占用方数已更新为 ${r.customerVolume} 方` : "已取消");
      setCancelTarget(null); setCancelReason("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "取消失败"); }
    finally { setCancelSubmitting(false); }
  };

  const handleUpdatePrice = async () => {
    if (!priceTarget || !selectedPlanId) return;
    setPriceSubmitting(true);
    try {
      const r = await apiRequest<{ totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/customers/price`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            planId: selectedPlanId,
            customerId: priceTarget.id,
            unitPriceNormal: editPriceNormal ? Number(editPriceNormal) : undefined,
            unitPriceInspection: editPriceInspection ? Number(editPriceInspection) : undefined,
            unitPriceSensitive: editPriceSensitive ? Number(editPriceSensitive) : undefined,
          }),
        }
      );
      setToast(r?.totalFee != null ? `单价已更新，未付款单据已按新价重算，客户总费用 ¥${r.totalFee}` : "单价已更新");
      setPriceTarget(null);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "更新失败"); }
    finally { setPriceSubmitting(false); }
  };

  /** 打开「新增客户」弹窗：客户列表是懒加载的，这里补一次 */
  const openAddCustomer = () => {
    setAddClientId(""); setAddSearch("");
    setAddPriceNormal(""); setAddPriceInspection(""); setAddPriceSensitive("");
    setShowAddCustomer(true);
    if (clients.length === 0) loadClients();
  };

  const handleAddCustomer = async () => {
    if (!selectedPlanId) return;
    if (!addClientId) { setToast("请选择客户"); return; }
    const checks: Array<[string, string]> = [
      ["普货", addPriceNormal], ["商检", addPriceInspection], ["敏感货", addPriceSensitive],
    ];
    for (const [label, v] of checks) {
      if (!v || Number(v) <= 0) { setToast(`${label}单价必须大于0`); return; }
    }
    setAddSubmitting(true);
    try {
      await apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/customers/add`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({
          planId: selectedPlanId,
          clientId: addClientId,
          unitPriceNormal: Number(addPriceNormal),
          unitPriceInspection: Number(addPriceInspection),
          unitPriceSensitive: Number(addPriceSensitive),
        }),
      });
      setToast("客户已加入本计划");
      setShowAddCustomer(false);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "新增失败"); }
    finally { setAddSubmitting(false); }
  };

  /** 移除客户。名下有预报单的后端会拦住，这里也先提示一次，免得白点 */
  const handleRemoveCustomer = async (c: CustomerDetail) => {
    if (!selectedPlanId) return;
    const paCount = c.prealerts?.length ?? 0;
    if (paCount > 0) {
      setToast(`${c.clientName} 名下还有 ${paCount} 个预报单，请先逐个取消后再移除`);
      return;
    }
    if (!confirm(`确定把「${c.clientName}」从本计划移除？\n\n该客户名下没有预报单，移除后只会删掉这条参与记录。`)) return;
    setRemovingCustomerId(c.id);
    try {
      await apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/customers/remove`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({ planId: selectedPlanId, customerId: c.id }),
      });
      setToast(`已移除 ${c.clientName}`);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "移除失败"); }
    finally { setRemovingCustomerId(""); }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================
  return (
    <RoleShell allowedRole="admin" title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>
            {toast}
          </div>
        )}

        {/* ================================================================ */}
        {/* 列表视图 */}
        {/* ================================================================ */}
        {!selectedPlanId && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>集货拼柜（仓库版）</h2>
              <button onClick={() => { setShowCreate(true); setClientSearch(""); loadClients(); }} style={btnConfirm}>+ 新建计划</button>
            </div>

            {loading ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p>
            ) : plans.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>暂无计划</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f9fafb" }}>
                    <th style={thS}>计划编号</th>
                    <th style={thS}>仓库</th>
                    <th style={thS}>柜型</th>
                    <th style={thS}>目的地</th>
                    <th style={thS}>总方数</th>
                    <th style={thS}>客户数</th>
                    <th style={thS}>状态</th>
                    <th style={thS}>创建人</th>
                    <th style={thS}>创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} onClick={() => { setSelectedPlanId(p.id); loadDetail(p.id); }} style={{ cursor: "pointer", background: "white" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#f9fafb" }}
                      onMouseLeave={e => { e.currentTarget.style.background = "white" }}>
                      <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                      <td style={tdS}>{p.warehouse}</td>
                      <td style={tdS}>{p.containerType}</td>
                      <td style={tdS}>{p.destinationTh}</td>
                      <td style={tdS}>{p.totalVolumeM3} 方</td>
                      <td style={tdS}>{p.customerCount}</td>
                      <td style={tdS}>
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[p.status]?.bg ?? "#e5e7eb", color: TAG[p.status]?.color ?? "#374151" }}>
                          {PLAN_STATUS_ZH[p.status] ?? p.status}
                        </span>
                      </td>
                      <td style={tdS}>{p.creatorName}</td>
                      <td style={{ ...tdS, fontSize: 12 }}>{formatBeijingTime(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 详情视图 */}
        {/* ================================================================ */}
        {selectedPlanId && (
          <>
            <button onClick={() => { setSelectedPlanId(null); setPlanDetail(null); setExpandedCustomer(null); }} style={{ ...btnCancel, marginBottom: 16 }}>← 返回列表</button>

            {detailLoading ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p>
            ) : !planDetail ? (
              <p style={{ color: "#ef4444", fontSize: 14 }}>加载计划详情失败</p>
            ) : (
              <>
                {/* 计划基本信息 */}
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 20px", marginBottom: 16, background: "#fafafa" }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 17 }}>{planDetail.planNo}</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px", fontSize: 13, color: "#374151" }}>
                    <div><span style={{ color: "#6b7280" }}>仓库：</span>{planDetail.warehouse}</div>
                    <div><span style={{ color: "#6b7280" }}>柜型：</span>{planDetail.containerType}</div>
                    <div><span style={{ color: "#6b7280" }}>目的地：</span>{planDetail.destinationTh}</div>
                    <div>
                      <span style={{ color: "#6b7280" }}>方数：</span>
                      {planDetail.usedVolumeM3 != null
                        ? `已用 ${planDetail.usedVolumeM3} / ${planDetail.totalVolumeM3} 方`
                        : `${planDetail.totalVolumeM3} 方`}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "#6b7280" }}>状态：</span>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "#e5e7eb", color: TAG[planDetail.status]?.color ?? "#374151" }}>
                        {PLAN_STATUS_ZH[planDetail.status] ?? planDetail.status}
                      </span>
                    </div>
                    <div><span style={{ color: "#6b7280" }}>创建人：</span>{planDetail.creatorName}</div>
                    <div><span style={{ color: "#6b7280" }}>创建时间：</span>{formatBeijingTime(planDetail.createdAt)}</div>
                  </div>
                </div>

                {/* 客户卡片列表 */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 16, margin: 0 }}>参与客户（{planDetail.customers.length}）</h3>
                  {/* 计划一旦开始装柜/发运就不给再加人，后端也拦了一道 */}
                  {["planning", "collecting"].includes(planDetail.status) && (
                    <button onClick={openAddCustomer} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}>新增客户</button>
                  )}
                </div>
                {planDetail.customers.map(c => {
                  const isExpanded = expandedCustomer === c.id;
                  return (
                    <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                      {/* 客户卡片头 */}
                      <div onClick={() => setExpandedCustomer(isExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: isExpanded ? "#f9fafb" : "white" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.clientName}</span>
                          <span style={{ fontSize: 12, color: "#6b7280" }}>{c.clientPhone} · {c.clientCompany}</span>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "#f3f4f6", color: "#6b7280" }}>参与客户</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <span style={{ fontSize: 13, color: "#6b7280" }}>
                            {c.totalVolumeM3} 方 · {c.totalPrealerts} 个预报单
                            {c.totalFee != null ? ` · ${money(c.totalFee)}` : ""}
                          </span>
                          <span style={{ fontSize: 12, color: "#9ca3af" }}>{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      {/* 客户卡片展开体 */}
                      {isExpanded && (
                        <div style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", background: "#fafafa" }}>
                          {/* 价格信息 */}
                          <div style={{ display: "flex", gap: 20, alignItems: "center", fontSize: 13, marginBottom: 10, color: "#374151" }}>
                            <span>普货：{c.unitPriceNormal} 元/方</span>
                            <span>商检：{c.unitPriceInspection} 元/方</span>
                            <span>敏感：{c.unitPriceSensitive} 元/方</span>
                            <button onClick={(e) => { e.stopPropagation(); setPriceTarget(c); setEditPriceNormal(String(c.unitPriceNormal)); setEditPriceInspection(String(c.unitPriceInspection)); setEditPriceSensitive(String(c.unitPriceSensitive)); }} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}>改单价</button>
                            {/* 已装柜/已发运的计划不给动参与名单，和「新增客户」同一条口径 */}
                            {["planning", "collecting"].includes(planDetail.status) && (
                              <button onClick={(e) => { e.stopPropagation(); handleRemoveCustomer(c); }} disabled={removingCustomerId === c.id} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12, color: "#b91c1c", borderColor: "#fecaca" }}>{removingCustomerId === c.id ? "移除中..." : "移除客户"}</button>
                            )}
                          </div>

                          {/* 总费用及其算式 */}
                          {c.feeBreakdown && c.feeBreakdown.rows.length > 0 && (
                            <div style={{ marginBottom: 10, maxWidth: 460 }}>
                              <FeeBreakdownPanel bd={c.feeBreakdown} title="总费用明细（全部未取消预报单合计）" />
                            </div>
                          )}

                          {/* 收货地址（客户端必填） */}
                          <div style={{ fontSize: 13, marginBottom: 10 }}>
                            {c.deliveryAddress?.trim() ? (
                              <span style={{ color: "#6b7280" }}>收货地址：{c.deliveryAddress}</span>
                            ) : (
                              <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "3px 8px", borderRadius: 4 }}>
                                收货地址未填写 —— 客户端已强制必填，该客户为历史数据，请联系其补填
                              </span>
                            )}
                          </div>

                          {/* 预报单列表 */}
                          {c.prealerts.length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>预报单（{c.prealerts.length}）</div>
                              {c.prealerts.map(pa => {
                                const paPkg = pa.items.reduce((s: number, it: any) => s + it.packageCount, 0);
                                const paVol = pa.items.reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
                                const paIsExpanded = expandedPrealert === pa.id;
                                // 预报单的流程状态：pa.status 是预报单级别的（pending, received_pending_payment, etc.）
                                const paStatus = pa.status;
                                const canReview = paStatus === "payment_submitted";
                                const canCancel = !["loading", "shipped", "thailand_received", "cancelled"].includes(paStatus);

                                return (
                                  <div key={pa.id} style={{ marginBottom: 8, border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
                                    {/* 预报单卡片头 */}
                                    <div onClick={() => setExpandedPrealert(paIsExpanded ? null : pa.id)} style={{ padding: "8px 12px", background: paIsExpanded ? "#eff6ff" : "#f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <strong>{pa.trackingNo}</strong>
                                        <span style={{ color: "#6b7280" }}>唛头：{pa.mark || "-"}</span>
                                        {pa.expressNo && <span style={{ color: "#6b7280" }}>快递：{pa.expressNo}</span>}
                                        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 3, background: TAG[paStatus]?.bg ?? "#e5e7eb", color: TAG[paStatus]?.color ?? "#374151" }}>
                                          {PREALERT_STATUS_ZH[paStatus] ?? paStatus}
                                        </span>
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        {pa.totalFee != null && <span style={{ fontWeight: 600, color: "#059669" }}>{money(pa.totalFee)}</span>}
                                        <span style={{ color: "#6b7280" }}>{paPkg}件 · {paVol.toFixed(3)}方</span>
                                        <span style={{ fontSize: 12, color: "#9ca3af" }}>{paIsExpanded ? "▲" : "▼"}</span>
                                      </div>
                                    </div>

                                    {/* 预报单卡片展开体 */}
                                    {paIsExpanded && (
                                      <div style={{ padding: "8px 12px", borderTop: "1px solid #e5e7eb", background: "#fff", fontSize: 12 }}>
                                        {/* 本单费用明细 */}
                                        {pa.feeBreakdown && pa.feeBreakdown.rows.length > 0 && (
                                          <div style={{ marginBottom: 8, maxWidth: 420 }}>
                                            <FeeBreakdownPanel bd={pa.feeBreakdown} title="本单费用明细" compact />
                                          </div>
                                        )}

                                        {/* 收货凭证 */}
                                        {pa.warehouseReceiptBase64 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "#6b7280", marginBottom: 4 }}>收货凭证</div>
                                            <img src={pa.warehouseReceiptBase64} alt="收货凭证" onClick={() => setPreviewImage(pa.warehouseReceiptBase64!)} style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                                          </div>
                                        )}

                                        {/* 付款截图 */}
                                        {pa.paymentProofs && pa.paymentProofs.length > 0 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "#6b7280", marginBottom: 4 }}>付款凭证（{pa.paymentProofs.length}张）</div>
                                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                              {pa.paymentProofs.map((p: any, i: number) => {
                                                const imgSrc = toImageSrc(p.base64Path || p.base64, p.mime);
                                                return imgSrc ? <img key={i} src={imgSrc} alt={`付款凭证 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} /> : null;
                                              })}
                                            </div>
                                          </div>
                                        )}

                                        {/* 拒绝原因 */}
                                        {pa.paymentRejectReason && (
                                          <div style={{ marginBottom: 8, padding: "6px 10px", background: "#fef2f2", borderRadius: 4, color: "#ef4444" }}>
                                            拒绝原因：{pa.paymentRejectReason}
                                          </div>
                                        )}

                                        {/* 泰国签收单 */}
                                        {pa.thailandReceiptBase64 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "#6b7280", marginBottom: 4 }}>泰国签收单</div>
                                            <img src={pa.thailandReceiptBase64} alt="泰国签收单" onClick={() => setPreviewImage(pa.thailandReceiptBase64!)} style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                                            {pa.thailandReceivedAt && <div style={{ color: "#6b7280", marginTop: 4 }}>签收时间：{formatBeijingTime(pa.thailandReceivedAt)}</div>}
                                          </div>
                                        )}

                                        {/* 操作按钮 */}
                                        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                                          {canReview && (
                                            <button onClick={(e) => { e.stopPropagation(); setReviewTarget({ planId: selectedPlanId!, prealert: pa }); }} style={btnConfirm}>审核付款</button>
                                          )}
                                          {canCancel && (
                                            <button onClick={(e) => { e.stopPropagation(); setCancelTarget({ planId: selectedPlanId!, prealert: pa }); }} style={btnCancel}>取消预报单</button>
                                          )}
                                        </div>

                                        {/* 预报单状态日志 */}
                                        {pa.statusLogs && pa.statusLogs.length > 0 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ fontWeight: 600, color: "#374151", marginBottom: 4 }}>状态日志</div>
                                            {pa.statusLogs.map((sl: any) => (
                                              <div key={sl.id} style={{ padding: "2px 0", color: "#6b7280", fontSize: 11 }}>
                                                <span style={{ color: "#374151" }}>{PREALERT_STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</span> → <span style={{ color: "#374151" }}>{PREALERT_STATUS_ZH[sl.toStatus] ?? sl.toStatus}</span>
                                                &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                                                {sl.remark && <span style={{ color: "#9ca3af", marginLeft: 8 }}>{sl.remark}</span>}
                                              </div>
                                            ))}
                                          </div>
                                        )}

                                        {/* 货品表格 */}
                                        {pa.items.length > 0 && (
                                          <div style={{ overflowX: "auto" }}>
                                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                              <thead><tr style={{ background: "#f3f4f6" }}>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>品名</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>件数</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>方数</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>类型</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>材质</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>货值</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>图片</th>
                                              </tr></thead>
                                              <tbody>
                                                {pa.items.map((it: any) => (
                                                  <tr key={it.id}>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.productName}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.packageCount}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(3) : "-"}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.material}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.cargoValue}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>
                                                      {it.productImageBase64 ? (
                                                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                          <img src={it.productImageBase64} alt="产品图片" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} />
                                                          <button onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} style={{ ...btnCancel, padding: "2px 6px", fontSize: 10 }}>查看</button>
                                                        </div>
                                                      ) : <span style={{ color: "#d1d5db" }}>暂无图片</span>}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                        {pa.items.length === 0 && <div style={{ color: "#9ca3af", padding: "4px 0" }}>暂无货品</div>}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* 客户状态时间线（由该客户所有预报单的日志聚合而来） */}
                          {(() => {
                            const logs = aggregateCustomerLogs(c.prealerts);
                            if (logs.length === 0) return null;
                            return (
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>状态时间线</div>
                                {logs.map((sl) => (
                                  <div key={sl.id} style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid #e5e7eb" }}>
                                    <strong style={{ color: "#2563eb", marginRight: 6 }}>{sl.trackingNo}</strong>
                                    <strong style={{ color: "#374151" }}>{PREALERT_STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</strong> → <strong style={{ color: "#374151" }}>{PREALERT_STATUS_ZH[sl.toStatus] ?? sl.toStatus}</strong>
                                    &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                                    {sl.remark && <div style={{ color: "#9ca3af", marginTop: 2 }}>{sl.remark}</div>}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 弹窗：审核付款（预报单级别） */}
        {/* ================================================================ */}
        {reviewTarget && (
          <Modal wide onClose={() => { setReviewTarget(null); setShowReject(false); }}>
            {showReject ? (
              <>
                <h3 style={{ marginTop: 0 }}>审核不通过</h3>
                <p style={{ fontSize: 13, color: "#6b7280" }}>预报单：{reviewTarget.prealert.trackingNo} · {reviewTarget.prealert.mark}</p>
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>拒绝原因 *</label>
                  <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="请填写拒绝原因" style={{ ...fi, minHeight: 80 }} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>修改单价（可选，留空不修改）</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280" }}>普货单价</label>
                      <input type="number" value={rejectPriceNormal} onChange={e => setRejectPriceNormal(e.target.value)} placeholder="留空不修改" style={fi} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280" }}>商检单价</label>
                      <input type="number" value={rejectPriceInspection} onChange={e => setRejectPriceInspection(e.target.value)} placeholder="留空不修改" style={fi} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280" }}>敏感单价</label>
                      <input type="number" value={rejectPriceSensitive} onChange={e => setRejectPriceSensitive(e.target.value)} placeholder="留空不修改" style={fi} />
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReject} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
                  <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnCancel}>取消</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>审核付款</h3>
                <div style={{ fontSize: 13 }}>
                  <p style={{ margin: "4px 0" }}>预报单：{reviewTarget.prealert.trackingNo} · 唛头：{reviewTarget.prealert.mark || "-"}</p>
                  {/* 货品明细 */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>货品明细</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ background: "#f3f4f6" }}>
                        {["品名","件数","方数","重量(kg)","类型"].map(h => <th key={h} style={{ ...thS, padding: "3px 6px", fontSize: 10 }}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {(reviewTarget.prealert.items ?? []).map((it: any, idx: number) => (
                          <tr key={idx}>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? (typeof it.volumeM3 === "number" ? it.volumeM3.toFixed(3) : it.volumeM3) : "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalWeightKg != null ? it.totalWeightKg : "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* 费用及其算式 */}
                  {reviewTarget.prealert.totalFee != null && (
                    <p style={{ margin: "8px 0 6px", fontSize: 16, fontWeight: 700, color: "#059669" }}>应付金额：{money(reviewTarget.prealert.totalFee)}</p>
                  )}
                  <FeeBreakdownPanel bd={reviewTarget.prealert.feeBreakdown} title="费用是这样算出来的" />
                  {/* 付款截图 */}
                  {(() => {
                    const proofs = reviewTarget.prealert.paymentProofs;
                    if (!proofs || proofs.length === 0) return null;
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>付款截图（{proofs.length}张）</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {proofs.map((p: any, i: number) => {
                            const imgSrc = toImageSrc(p.base64Path || p.base64, p.mime);
                            return imgSrc ? <img key={i} src={imgSrc} alt={`付款截图 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} /> : null;
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleApprove} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "..." : "审核通过"}</button>
                  <button onClick={() => { setShowReject(true); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive(""); }} style={btnCancel}>审核不通过</button>
                </div>
              </>
            )}
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：取消资格（预报单级别） */}
        {/* ================================================================ */}
        {cancelTarget && (
          <Modal onClose={() => { setCancelTarget(null); setCancelReason(""); }}>
            <h3 style={{ marginTop: 0 }}>取消预报单</h3>
            <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>预报单：{cancelTarget.prealert.trackingNo} · {cancelTarget.prealert.mark}</p>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 10 }}>此操作不可恢复，将取消该预报单并释放已占用方数。</p>
            <div>
              <label style={fl}>取消原因 *</label>
              <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="请填写取消原因" style={{ ...fi, minHeight: 80 }} />
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCancel} disabled={cancelSubmitting} style={btnDanger}>{cancelSubmitting ? "提交中..." : "确认取消"}</button>
              <button onClick={() => { setCancelTarget(null); setCancelReason(""); }} style={btnCancel}>返回</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：改单价 */}
        {/* ================================================================ */}
        {priceTarget && selectedPlanId && (
          <Modal onClose={() => setPriceTarget(null)}>
            <h3 style={{ marginTop: 0 }}>修改单价 - {priceTarget.clientName}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
              <div>
                <label style={fl}>普货单价 (元/方)</label>
                <input type="number" value={editPriceNormal} onChange={e => setEditPriceNormal(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>商检单价 (元/方)</label>
                <input type="number" value={editPriceInspection} onChange={e => setEditPriceInspection(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>敏感单价 (元/方)</label>
                <input type="number" value={editPriceSensitive} onChange={e => setEditPriceSensitive(e.target.value)} style={fi} />
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleUpdatePrice} disabled={priceSubmitting} style={btnConfirm}>{priceSubmitting ? "保存中..." : "保存"}</button>
              <button onClick={() => setPriceTarget(null)} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：新增参与客户（2026-08-07）                                   */}
        {/* ================================================================ */}
        {showAddCustomer && selectedPlanId && planDetail && (() => {
          // 已经在本计划里的客户不再出现在候选里，避免重复添加被后端打回
          const joined = new Set(planDetail.customers.map(c => c.clientId));
          const q = addSearch.trim().toLowerCase();
          const options = clients.filter(cl => !joined.has(cl.id)).filter(cl =>
            !q || (cl.name ?? "").toLowerCase().includes(q)
              || (cl.phone ?? "").toLowerCase().includes(q)
              || (cl.companyName ?? "").toLowerCase().includes(q));
          return (
            <Modal onClose={() => setShowAddCustomer(false)}>
              <h3 style={{ marginTop: 0 }}>新增参与客户 - {planDetail.planNo}</h3>
              <div style={{ marginTop: 10 }}>
                <label style={fl}>选择客户</label>
                <input value={addSearch} onChange={e => setAddSearch(e.target.value)} placeholder="搜索客户名 / 电话 / 公司" style={fi} />
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6, marginTop: 6 }}>
                  {clientsLoading ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "#9ca3af" }}>加载客户列表中…</div>
                  ) : options.length === 0 ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "#9ca3af" }}>
                      没有可选客户{joined.size > 0 ? "（已在本计划里的客户不会重复出现）" : ""}
                    </div>
                  ) : options.map(cl => (
                    <label key={cl.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <input type="radio" name="add-whr-client" checked={addClientId === cl.id} onChange={() => setAddClientId(cl.id)} />
                      <span style={{ fontWeight: 600 }}>{cl.name}</span>
                      <span style={{ color: "#6b7280", fontSize: 12 }}>{cl.phone}{cl.companyName ? ` · ${cl.companyName}` : ""}</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>共 {options.length} 位可选</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
                <div>
                  <label style={fl}>普货单价 (元/方)</label>
                  <input type="number" value={addPriceNormal} onChange={e => setAddPriceNormal(e.target.value)} style={fi} />
                </div>
                <div>
                  <label style={fl}>商检单价 (元/方)</label>
                  <input type="number" value={addPriceInspection} onChange={e => setAddPriceInspection(e.target.value)} style={fi} />
                </div>
                <div>
                  <label style={fl}>敏感单价 (元/方)</label>
                  <input type="number" value={addPriceSensitive} onChange={e => setAddPriceSensitive(e.target.value)} style={fi} />
                </div>
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleAddCustomer} disabled={addSubmitting} style={btnConfirm}>{addSubmitting ? "添加中..." : "确认新增"}</button>
                <button onClick={() => setShowAddCustomer(false)} style={btnCancel}>取消</button>
              </div>
            </Modal>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：新建计划 */}
        {/* ================================================================ */}
        {showCreate && (
          <Modal wide onClose={() => setShowCreate(false)}>
            <h3 style={{ marginTop: 0 }}>新建拼柜计划</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={fl}>发货仓库</label>
                <select value={newWarehouse} onChange={e => setNewWarehouse(e.target.value)} style={fi}>
                  <option value="义乌">义乌</option>
                  <option value="深圳">深圳</option>
                  <option value="广州">广州</option>
                </select>
              </div>
              <div>
                <label style={fl}>柜型</label>
                <select value={newContainerType} onChange={e => setNewContainerType(e.target.value)} style={fi}>
                  <option value="40HQ">40HQ</option>
                  <option value="40GP">40GP</option>
                  <option value="20GP">20GP</option>
                </select>
              </div>
              <div>
                <label style={fl}>目的地</label>
                <input value={newDestinationTh} onChange={e => setNewDestinationTh(e.target.value)} placeholder="如 曼谷" style={fi} />
              </div>
              <div>
                <label style={fl}>总方数</label>
                <input type="number" value={newTotalVolume} onChange={e => setNewTotalVolume(e.target.value)} style={fi} />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={fl}>选择客户</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="按姓名 / 电话 / 公司搜索" style={{ ...fi, flex: 1 }} />
                <button onClick={() => loadClients()} style={btnCancel} disabled={clientsLoading}>{clientsLoading ? "刷新中..." : "刷新列表"}</button>
              </div>
              <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "#f3f4f6" }}>
                    <th style={{ ...thS, padding: "4px 8px", width: 40 }}></th>
                    <th style={{ ...thS, padding: "4px 8px" }}>客户名</th>
                    <th style={{ ...thS, padding: "4px 8px" }}>电话</th>
                    <th style={{ ...thS, padding: "4px 8px" }}>公司</th>
                  </tr></thead>
                  <tbody>
                    {filteredClients.length === 0 && (
                      <tr><td colSpan={4} style={{ ...tdS, padding: "10px 8px", color: "#9ca3af" }}>没有匹配的客户</td></tr>
                    )}
                    {filteredClients.map(cl => {
                      const isChecked = selectedCustomers.some(sc => sc.clientId === cl.id);
                      return (
                        <tr key={cl.id} style={{ cursor: "pointer", background: isChecked ? "#eff6ff" : "white" }}>
                          <td style={{ ...tdS, padding: "4px 8px", textAlign: "center" }}>
                            <input type="checkbox" checked={isChecked} onChange={() => {
                              if (isChecked) setSelectedCustomers(selectedCustomers.filter(sc => sc.clientId !== cl.id));
                              else setSelectedCustomers([...selectedCustomers, { clientId: cl.id, unitPriceNormal: "", unitPriceInspection: "", unitPriceSensitive: "" }]);
                            }} />
                          </td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.name}</td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.phone}</td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.companyName ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedCustomers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={fl}>设置单价（已选 {selectedCustomers.length} 位客户）</label>
                {selectedCustomers.map((sc, idx) => {
                  const client = clients.find(cl => cl.id === sc.clientId);
                  return (
                    <div key={sc.clientId} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 12px", marginBottom: 8 }}>
                      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{client?.name ?? sc.clientId}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>普货 (元/方)</label>
                          <input type="number" value={sc.unitPriceNormal} onChange={e => {
                            const cp = [...selectedCustomers];
                            cp[idx] = { ...cp[idx], unitPriceNormal: e.target.value };
                            setSelectedCustomers(cp);
                          }} style={{ ...fi, marginTop: 2 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>商检 (元/方)</label>
                          <input type="number" value={sc.unitPriceInspection} onChange={e => {
                            const cp = [...selectedCustomers];
                            cp[idx] = { ...cp[idx], unitPriceInspection: e.target.value };
                            setSelectedCustomers(cp);
                          }} style={{ ...fi, marginTop: 2 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>敏感 (元/方)</label>
                          <input type="number" value={sc.unitPriceSensitive} onChange={e => {
                            const cp = [...selectedCustomers];
                            cp[idx] = { ...cp[idx], unitPriceSensitive: e.target.value };
                            setSelectedCustomers(cp);
                          }} style={{ ...fi, marginTop: 2 }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCreate} disabled={createSubmitting} style={btnConfirm}>{createSubmitting ? "创建中..." : "确认创建"}</button>
              <button onClick={() => setShowCreate(false)} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

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
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: wide ? 700 : 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
