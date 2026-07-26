"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { apiBaseUrl, apiRequest } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

// 单张凭证上传上限（原图字节）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const jsonPost = { "Content-Type": "application/json" } as const;

/** 把接口返回的图片字段（可能是 /images 路径、data URL 或裸 base64）统一成可用的 src */
function toImageSrc(src: unknown, mime?: string): string {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:") || src.startsWith("/") || src.startsWith("http")) return src;
  return `data:${mime || "image/png"};base64,${src}`;
}

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

/** 本地时区的 YYYY-MM-DD，用于导出文件名（原来用 UTC，晚上导出会显示成前一天） */
function localDateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================================
// 状态中文
// ============================================================================
const PLAN_ST_ZH: Record<string, string> = {
  planning: "计划中", collecting: "集货中", loading: "装柜中", shipped: "已发运", completed: "已完成", cancelled: "已取消",
};
const PREALERT_ST_ZH: Record<string, string> = {
  pending: "待签收", received_pending_payment: "待付款", payment_submitted: "待审核",
  paid: "已付款", loading: "装柜中", shipped: "已发运", thailand_received: "泰国已签收", cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
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
interface DispatchCustomerItem {
  id: string; productName: string; packageCount: number; quantityPerBox: number;
  totalQuantity: number; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  unitWeightKg: number | null; totalWeightKg: number | null; volumeM3: number | null;
  material: string; cargoValue: string; cargoType: string;
  productImageFileName: string | null; productImageBase64: string | null; sortOrder: number;
}
interface DispatchCustomer {
  id: string; clientId: string; clientName: string; clientPhone: string; clientCompany: string;
  status?: string; unitPriceNormal: number; unitPriceInspection: number; unitPriceSensitive: number;
  totalVolumeM3: number; totalFee: number | null; deliveryAddress: string | null; addressMissing?: boolean;
  totalItems: number; totalPackages: number; createdAt: string; 
  prealerts?: { id: string; trackingNo: string; mark: string; expressNo: string | null; status: string; warehouseReceiptBase64?: string | null; thailandReceiptBase64?: string | null; items: DispatchCustomerItem[] }[];
}
interface DispatchPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; planStatus: string; customers: DispatchCustomer[]; createdAt: string;
}

// Operations Tab — 预报单级别
interface OpsPrealert {
  prealertId: string; trackingNo: string; expressNo?: string | null; mark: string; status: string;
  clientId: string; customerId?: string; clientName: string; clientPhone: string | null; clientCompany: string | null;
  deliveryAddress: string | null; addressMissing?: boolean;
  itemCount: number; volumeM3: number; packageCount: number;
  totalFee?: number | null;
  paymentProofs?: any[];
  thailandReceiptBase64?: string | null;
}
interface OpsPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; usedVolumeM3?: number; status?: string;
  sections: {
    pending: OpsPrealert[];
    received_pending_payment: OpsPrealert[];
    payment_submitted: OpsPrealert[];
    paid: OpsPrealert[];
    loading: OpsPrealert[];
    shipped: OpsPrealert[];
  };
}

interface PlanItem {
  id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; status: string; creatorName: string; customerCount: number; createdAt: string;
}
interface PlanDetail { id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; status: string; creatorName: string; createdAt: string; updatedAt: string;
  customers: any[];
}

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };
const btnBlue: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnGray: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnGreen: React.CSSProperties = { padding: "8px 18px", background: "#059669", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

// ============================================================================
// 主页面
// ============================================================================
export default function StaffWhrConsolidationPage() {
  const [activeTab, setActiveTab] = useState<"dispatch" | "operations" | "plans">("dispatch");
  const [toast, setToast] = useState<string>("");

  // ---- 尾端拆派 ----
  const [dispatchData, setDispatchData] = useState<DispatchPlan[]>([]);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ---- 操作区 ----
  const [opsPlans, setOpsPlans] = useState<OpsPlan[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsActionSubmitting, setOpsActionSubmitting] = useState<Record<string, boolean>>({});

  // ---- 泰国签收 ----
  const [thailandTarget, setThailandTarget] = useState<{ planId: string; prealertId: string; planNo: string; trackingNo: string; clientName: string; volumeM3: number } | null>(null);
  const [thailandFile, setThailandFile] = useState<{ base64: string; fileName: string; mime: string } | null>(null);
  const [thailandSubmitting, setThailandSubmitting] = useState(false);

  // ---- 仓库签收 ----
  const [signTarget, setSignTarget] = useState<{ planId: string; prealertId: string; planNo: string; trackingNo: string; mark: string; clientName: string; clientPhone?: string; clientCompany?: string; deliveryAddress: string | null; items?: any[]; loading?: boolean } | null>(null);
  const [signFile, setSignFile] = useState<{ base64: string; fileName: string; mime: string } | null>(null);
  const [signSubmitting, setSignSubmitting] = useState(false);

  // ---- 审核付款 ----
  const [reviewTarget, setReviewTarget] = useState<any>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectPriceNormal, setRejectPriceNormal] = useState("");
  const [rejectPriceInspection, setRejectPriceInspection] = useState("");
  const [rejectPriceSensitive, setRejectPriceSensitive] = useState("");

  // ---- 拼柜计划 ----
  const [planList, setPlanList] = useState<PlanItem[]>([]);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // ---- 图片预览 ----
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ================================================================
  // 数据加载
  // ================================================================
  const loadDispatch = useCallback(async () => {
    setDispatchLoading(true);
    try {
      const data = await apiRequest<{ items: DispatchPlan[] }>(`${apiBaseUrl()}/staff/whr-consolidation/dispatch-view`);
      setDispatchData(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载拆派视图失败"); }
    finally { setDispatchLoading(false); }
  }, []);

  const loadOperations = useCallback(async () => {
    setOpsLoading(true);
    try {
      const data = await apiRequest<{ plans: OpsPlan[] }>(`${apiBaseUrl()}/staff/whr-consolidation/operations`);
      setOpsPlans(data.plans ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载操作数据失败"); }
    finally { setOpsLoading(false); }
  }, []);

  const loadPlans = useCallback(async () => {
    setPlanLoading(true);
    try {
      const data = await apiRequest<{ items: PlanItem[] }>(`${apiBaseUrl()}/admin/whr-consolidation/plans`);
      setPlanList(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载计划列表失败"); }
    finally { setPlanLoading(false); }
  }, []);

  const loadPlanDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await apiRequest<PlanDetail>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`
      );
      setPlanDetail(data);
    } catch (e: any) { setToast(e?.message ?? "加载详情失败"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (activeTab === "dispatch") loadDispatch();
    else if (activeTab === "operations") loadOperations();
    else if (activeTab === "plans") loadPlans();
  }, [activeTab, loadDispatch, loadOperations, loadPlans]);

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ================================================================
  // 操作函数 — 预报单级别
  // ================================================================
  // ---- 取消预报单 ----
  const handleCancelPrealert = (planId: string, prealertId: string, trackingNo: string) => {
    if (!window.confirm("确认取消预报单 " + trackingNo + "？将释放已占用方数。")) return;
    doPrealertAction("/admin/whr-consolidation/prealerts/cancel", planId, prealertId, "cancel-" + prealertId, { cancelReason: "员工主动取消" });
  };

  const doPrealertAction = async (url: string, planId: string, prealertId: string, key: string, extraBody?: any) => {
    setOpsActionSubmitting(p => ({ ...p, [key]: true }));
    try {
      const body: any = { planId, prealertId, ...extraBody };
      await apiRequest<any>(`${apiBaseUrl()}${url}`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify(body),
      });
      setToast("操作成功");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setOpsActionSubmitting(p => ({ ...p, [key]: false })); }
  };

  // ---- 仓库签收 ----
  const handleOpenSign = async (pa: any, planId: string) => {
    // 先弹出弹窗显示基本信息 + loading
    setSignTarget({
      planId, prealertId: pa.prealertId, planNo: pa.planNo || "",
      trackingNo: pa.trackingNo, mark: pa.mark, clientName: pa.clientName,
      deliveryAddress: pa.deliveryAddress, loading: true,
    });
    try {
      const detail = await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-detail?prealertId=${encodeURIComponent(pa.prealertId)}`
      );
      setSignTarget({
        planId, prealertId: pa.prealertId, planNo: pa.planNo || "",
        trackingNo: pa.trackingNo, mark: pa.mark,
        clientName: detail.clientName ?? pa.clientName,
        clientPhone: detail.clientPhone,
        clientCompany: detail.clientCompany,
        deliveryAddress: detail.deliveryAddress ?? pa.deliveryAddress,
        items: detail.items ?? [],
        loading: false,
      });
    } catch (e: any) {
      setToast(e?.message ?? "加载预报单详情失败");
      setSignTarget(null);
    }
  };

  const handleWarehouseSign = async () => {
    if (!signTarget || !signFile) { setToast("请上传收货凭证照片"); return; }
    setSignSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-sign`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({
            planId: signTarget.planId, prealertId: signTarget.prealertId,
            receiptFileName: signFile.fileName, receiptMime: signFile.mime, receiptBase64: signFile.base64,
          }),
        }
      );
      setToast("签收成功");
      setSignTarget(null); setSignFile(null);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "签收失败"); }
    finally { setSignSubmitting(false); }
  };

  // ---- 审核付款 ----
  const handleOpenReview = async (pa: OpsPrealert, planId: string) => {
    // 先用操作区已有数据把弹窗打开，再补货品明细
    setReviewTarget({ planId, prealert: pa, loading: true });
    try {
      // 只拉这一条预报单，不再为了一条单去拉整个计划的全部客户和货品
      const detail = await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-detail?prealertId=${encodeURIComponent(pa.prealertId)}`
      );
      const unitPrices = {
        unitPriceNormal: detail.unitPriceNormal,
        unitPriceInspection: detail.unitPriceInspection,
        unitPriceSensitive: detail.unitPriceSensitive,
      };
      setReviewTarget({
        planId,
        prealert: {
          ...pa,
          items: detail.items ?? [],
          unitPrices,
          totalFee: detail.totalFee ?? pa.totalFee,
          paymentProofs: detail.paymentProofs ?? pa.paymentProofs,
          deliveryAddress: detail.deliveryAddress ?? pa.deliveryAddress,
          feeBreakdown: detail.feeBreakdown,
        },
        loading: false,
      });
    } catch (e: any) {
      setToast(e?.message ?? "加载货品详情失败");
      setReviewTarget(null);
    }
  };

  const handleReviewApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({ planId: reviewTarget.planId, prealertId: reviewTarget.prealert.prealertId, action: "approve" }),
        }
      );
      setToast("审核通过");
      setReviewTarget(null);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "审核失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleReviewReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      const r = await apiRequest<{ totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({
            planId: reviewTarget.planId, prealertId: reviewTarget.prealert.prealertId,
            action: "reject", rejectReason: rejectReason.trim(),
            unitPriceNormal: rejectPriceNormal ? Number(rejectPriceNormal) : undefined,
            unitPriceInspection: rejectPriceInspection ? Number(rejectPriceInspection) : undefined,
            unitPriceSensitive: rejectPriceSensitive ? Number(rejectPriceSensitive) : undefined,
          }),
        }
      );
      setToast(r?.totalFee != null ? `已拒绝，应付金额已更新为 ¥${r.totalFee}` : "已拒绝");
      setShowReject(false); setReviewTarget(null); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive("");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setReviewSubmitting(false); }
  };

  // ---- 装柜确认 ----
  const handleLoadingConfirm = (planId: string, prealertId: string, key: string) => {
    doPrealertAction("/staff/whr-consolidation/loading-confirm", planId, prealertId, key);
  };

  // ---- 发运确认 ----
  const handleShipConfirm = (planId: string, prealertId: string, key: string) => {
    doPrealertAction("/staff/whr-consolidation/ship-confirm", planId, prealertId, key);
  };

  // ---- 泰国签收 ----
  const handleThailandSign = async () => {
    if (!thailandTarget || !thailandFile) { setToast("请选择签收单文件"); return; }
    setThailandSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/thailand-sign`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            planId: thailandTarget.planId, prealertId: thailandTarget.prealertId,
            fileName: thailandFile.fileName, mime: thailandFile.mime, base64: thailandFile.base64,
          }),
        }
      );
      setToast("泰国签收成功");
      setThailandTarget(null); setThailandFile(null);
      loadOperations(); loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "签收失败"); }
    finally { setThailandSubmitting(false); }
  };

  // ================================================================
  // Excel 导出
  // ================================================================
  const handleExportPlan = async (p: DispatchPlan) => {
    setExporting(true);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("尾端拆派");

      const headers = ["计划编号", "仓库", "柜型", "目的地", "客户名", "预报单号", "唛头", "品名", "件数", "方数(m³)", "重量(kg)", "收货地址", "状态"];
      const colCount = headers.length;

      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });

      const planHeaderStyle = {
        font: { bold: true, size: 12, color: { argb: "FFFFFFFF" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF2563EB" } },
        alignment: { horizontal: "left" as const, vertical: "middle" as const },
      };
      const subtotalStyle = {
        font: { bold: true, size: 11, color: { argb: "FF059669" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF0FDF4" } },
      };

      let currentRow = 2;
        const planTitleRow = ws.addRow([`${p.planNo}  ${p.warehouse}  ${p.containerType}  →  ${p.destinationTh}  ${p.totalVolumeM3}方`]);
        ws.mergeCells(currentRow, 1, currentRow, colCount);
        planTitleRow.eachCell((cell) => {
          cell.font = planHeaderStyle.font;
          cell.fill = planHeaderStyle.fill;
          cell.alignment = planHeaderStyle.alignment;
        });
        planTitleRow.height = 24;
        currentRow++;

        let planTotalVol = 0;

        for (const c of p.customers) {
          const prealerts = c.prealerts ?? [];
          let customerTotalVol = 0;

          if (prealerts.length === 0) {
            ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, "", "", "", "", "", "", c.deliveryAddress ?? "", c.status ? (PREALERT_ST_ZH[c.status] ?? c.status) : ""]);
            currentRow++;
          } else {
            for (const pa of prealerts) {
              const items = pa.items ?? [];
              let isFirst = true;

              if (items.length === 0) {
                ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, pa.trackingNo, pa.mark, "", "", "", "", c.deliveryAddress ?? "", PREALERT_ST_ZH[pa.status] ?? pa.status]);
                currentRow++;
              } else {
                for (const it of items) {
                  const vol = it.volumeM3 ?? 0;
                  customerTotalVol += vol;
                  planTotalVol += vol;

                  const dataRow = ws.addRow([
                    p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName,
                    isFirst ? pa.trackingNo : "",
                    isFirst ? pa.mark : "",
                    it.productName, it.packageCount, vol, it.totalWeightKg ?? 0,
                    c.deliveryAddress ?? "", PREALERT_ST_ZH[pa.status] ?? pa.status,
                  ]);
                  dataRow.getCell(10).numFmt = "0.000";
                  isFirst = false;
                  currentRow++;
                }
              }
            }
          }

          if (customerTotalVol > 0) {
            // 单元格数量必须和表头一致（13 列），方数写数字而不是字符串，Excel 里才能求和
            const subRow = ws.addRow([
              "", "", "", "", `${c.clientName} 小计`, "", "", "", "",
              Math.round(customerTotalVol * 1000) / 1000, "", "", "",
            ]);
            subRow.getCell(10).numFmt = "0.000";
            subRow.eachCell((cell, colIdx) => {
              if (colIdx === 10) cell.font = subtotalStyle.font;
              cell.fill = subtotalStyle.fill;
            });
            currentRow++;
          }
        }

        if (planTotalVol > 0) {
          const totalRow = ws.addRow([
            "", "", "", "", `${p.planNo} 合计`, "", "", "", "",
            Math.round(planTotalVol * 1000) / 1000, "", "", "",
          ]);
          totalRow.getCell(10).numFmt = "0.000";
          totalRow.eachCell((cell, colIdx) => {
            if (colIdx === 10) cell.font = { bold: true, size: 12, color: { argb: "FF059669" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } };
          });
          totalRow.height = 22;
          currentRow++;
        }

      ws.columns = headers.map((_, i) => {
        if (i === 0 || i === 4 || i === 5 || i === 11) return { width: 16 };
        if (i === 7) return { width: 18 };
        return { width: 12 };
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `尾端拆派_${p.planNo}_${localDateStamp()}.xlsx`; a.click();
      URL.revokeObjectURL(url);
      setToast("导出成功");
    } catch (e: any) { setToast(e?.message ?? "导出失败"); }
    finally { setExporting(false); }
  };

  // ================================================================
  // 渲染
  // ================================================================
  const tabBtnStyle = (tab: string): React.CSSProperties => ({
    padding: "10px 24px", border: "none", background: activeTab === tab ? "#2563eb" : "#f3f4f6",
    color: activeTab === tab ? "#fff" : "#374151", borderRadius: "8px 8px 0 0", cursor: "pointer", fontWeight: 600, fontSize: 14,
  });

  return (
    <RoleShell allowedRole={["staff", "admin"]} title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>{toast}</div>
        )}

        {/* Tab 切换 */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #2563eb" }}>
          <button onClick={() => { setActiveTab("dispatch"); setExpandedPlan(null); setExpandedCustomer(null); }} style={tabBtnStyle("dispatch")}>尾端拆派</button>
          <button onClick={() => setActiveTab("operations")} style={tabBtnStyle("operations")}>操作区</button>
          <button onClick={() => { setActiveTab("plans"); setSelectedPlanId(null); setPlanDetail(null); }} style={tabBtnStyle("plans")}>拼柜计划</button>
        </div>

        {/* ================================================================ */}
        {/* TAB 1: 尾端拆派 */}
        {/* ================================================================ */}
        {activeTab === "dispatch" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 17, margin: 0 }}>尾端拆派</h3>
            </div>
            {dispatchLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> : (
              dispatchData.length === 0 ? <p style={{ color: "#9ca3af", padding: "24px 0" }}>暂无数据</p> :
              dispatchData.map(p => {
                const planExpanded = expandedPlan === p.planId;
                return (
                  <div key={p.planId} style={{ marginBottom: 16, border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f9fafb" }}>
                      <div onClick={() => setExpandedPlan(planExpanded ? null : p.planId)} style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                        <strong style={{ fontSize: 15 }}>{p.planNo}</strong>
                        <span style={{ fontSize: 13, color: "#6b7280" }}>{p.warehouse} · {p.containerType} · {p.destinationTh} · {p.totalVolumeM3}方</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button onClick={(e) => { e.stopPropagation(); handleExportPlan(p); }} disabled={exporting} style={{ ...btnGreen, padding: "4px 12px", fontSize: 12 }}>导出</button>
                        <span onClick={() => setExpandedPlan(planExpanded ? null : p.planId)} style={{ fontSize: 12, color: "#9ca3af" }}>{p.customers.length} 个客户 {planExpanded ? "▲" : "▼"}</span>
                      </div>
                    </div>
                    {planExpanded && p.customers.map(c => {
                      const cExpanded = expandedCustomer === c.id;
                      const flatItems = (c.prealerts ?? []).flatMap(pa => (pa.items ?? []).map(it => ({ ...it, prealertTrackingNo: pa.trackingNo, prealertMark: pa.mark })));
                      return (
                        <div key={c.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                          <div onClick={() => setExpandedCustomer(cExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: cExpanded ? "#fafafa" : "white" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <strong style={{ fontSize: 14 }}>{c.clientName}</strong>
                              <span style={{ fontSize: 12, color: "#6b7280" }}>{c.clientPhone} · {c.clientCompany}</span>
                              {/* 客户维度状态由后端按所有预报单推导，不再拿第一条单的状态冒充 */}
                              {c.status && <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[c.status]?.bg ?? "#e5e7eb", color: TAG[c.status]?.color ?? "#374151" }}>{PREALERT_ST_ZH[c.status] ?? c.status}</span>}
                              {(c.prealerts ?? []).map(pa => pa.warehouseReceiptBase64 ? <img key={`wr-${pa.id}`} src={pa.warehouseReceiptBase64} alt="收货凭证" onClick={(e) => { e.stopPropagation(); setPreviewImage(pa.warehouseReceiptBase64!); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} title="收货凭证" /> : null)}
                              {(c.prealerts ?? []).map(pa => pa.thailandReceiptBase64 ? <img key={`th-${pa.id}`} src={pa.thailandReceiptBase64} alt="泰国签收单" onClick={(e) => { e.stopPropagation(); setPreviewImage(pa.thailandReceiptBase64!); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid #10b981", cursor: "pointer" }} title="泰国签收单" /> : null)}
                            </div>
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>
                              {!c.deliveryAddress && <span style={{ color: "#b91c1c", marginRight: 8 }}>⚠ 缺地址</span>}
                              {c.totalVolumeM3}方 · {c.totalPackages}件 {cExpanded ? "▲" : "▼"}
                            </span>
                          </div>
                          {cExpanded && flatItems.length > 0 && (
                            <div style={{ padding: "8px 16px", background: "#fafafa", overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead><tr style={{ background: "#f3f4f6" }}>
                                  {["预报单号", "唛头", "品名", "件数", "方数(m³)", "重量(kg)", "类型"].map(h => <th key={h} style={{ ...thS, padding: "4px 8px", fontSize: 11 }}>{h}</th>)}
                                </tr></thead>
                                <tbody>{flatItems.map((it, i) => (
                                  <tr key={i}>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11, minWidth: 100, whiteSpace: "nowrap" }}>{(it as any).prealertTrackingNo}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11, minWidth: 80, whiteSpace: "nowrap" }}>{(it as any).prealertMark}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.productName}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.packageCount}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3 : "-"}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.totalWeightKg != null ? it.totalWeightKg : "-"}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          )}
                          {cExpanded && (
                            <div style={{ padding: "4px 16px 8px", fontSize: 12 }}>
                              {c.deliveryAddress
                                ? <span style={{ color: "#6b7280" }}>收货地址：{c.deliveryAddress}</span>
                                : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "2px 8px", borderRadius: 4 }}>⚠ 收货地址未填写，无法派送 —— 请联系该客户在客户端补填</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 2: 操作区 */}
        {/* ================================================================ */}
        {activeTab === "operations" && (
          <>
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>操作区</h3>
            {opsLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> : (
              opsPlans.length === 0 ? <p style={{ color: "#9ca3af", padding: "24px 0" }}>暂无活跃计划</p> :
              opsPlans.map(p => (
                <div key={p.planId} style={{ marginBottom: 20, border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "10px 16px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 12, alignItems: "center", fontSize: 14, fontWeight: 600, color: "#1f2937" }}>
                    <span>{p.planNo}</span>
                    <span style={{ fontWeight: 400, fontSize: 13, color: "#6b7280" }}>
                      {p.warehouse} · {p.containerType} · {p.destinationTh} ·{" "}
                      {p.usedVolumeM3 != null ? `已用 ${p.usedVolumeM3} / ${p.totalVolumeM3} 方` : `${p.totalVolumeM3}方`}
                    </span>
                  </div>

                  {/* --- 待签收 --- */}
                  {/* --- 待签收 --- */}
                  {p.sections.pending.length > 0 && (
                    <Section title="仓库签收" count={p.sections.pending.length} emptyMsg="">
                      {p.sections.pending.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button onClick={() => handleOpenSign(pa, p.planId)} style={btnBlue}>签收</button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待付款（只读展示，等待客户端上传付款凭证） --- */}
                  {p.sections.received_pending_payment.length > 0 && (
                    <Section title="待付款" count={p.sections.received_pending_payment.length} emptyMsg="">
                      {p.sections.received_pending_payment.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            {pa.totalFee != null && <span style={{ color: "#059669", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待审核付款 --- */}
                  {p.sections.payment_submitted.length > 0 && (
                    <Section title="审核付款" count={p.sections.payment_submitted.length} emptyMsg="">
                      {p.sections.payment_submitted.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            {pa.totalFee != null && <span style={{ color: "#059669", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                            {pa.paymentProofs && pa.paymentProofs.length > 0 && (
                              <span style={{ marginLeft: 8, display: "inline-flex", gap: 4 }}>
                                {(pa.paymentProofs as any[]).slice(0, 3).map((pf: any, i: number) => {
                                  const imgSrc = toImageSrc(pf?.base64Path || pf?.base64 || pf, pf?.mime);
                                  if (!imgSrc) return null;
                                  return <img key={i} src={imgSrc} alt={`凭证${i+1}`} onClick={(e) => { e.stopPropagation(); setPreviewImage(imgSrc); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 3, border: "1px solid #e5e7eb", cursor: "pointer" }} />;
                                })}
                                {pa.paymentProofs.length > 3 && <span style={{ fontSize: 11, color: "#9ca3af" }}>+{pa.paymentProofs.length - 3}</span>}
                              </span>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button onClick={() => handleOpenReview(pa, p.planId)} style={btnBlue}>审核</button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待装柜 --- */}
                  {p.sections.paid.length > 0 && (
                    <Section title="装柜确认" count={p.sections.paid.length} emptyMsg="">
                      {p.sections.paid.map(pa => {
                        const key = `loading-${pa.prealertId}`;
                        return (
                          <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                            <div style={{ flex: 1 }}>
                              <strong>{pa.clientName}</strong>
                              <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                              <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                              {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                              {pa.totalFee != null && <span style={{ color: "#059669", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                              <button onClick={() => handleLoadingConfirm(p.planId, pa.prealertId, key)} disabled={opsActionSubmitting[key]} style={btnBlue}>{opsActionSubmitting[key] ? "..." : "确认装柜"}</button>
                              <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                            </div>
                          </div>
                        );
                      })}
                    </Section>
                  )}

                  {/* --- 待发运 --- */}
                  {p.sections.loading.length > 0 && (
                    <Section title="发运确认" count={p.sections.loading.length} emptyMsg="">
                      {p.sections.loading.map(pa => {
                        const key = `ship-${pa.prealertId}`;
                        return (
                          <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                            <div style={{ flex: 1 }}>
                              <strong>{pa.clientName}</strong>
                              <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                              <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                              {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                              <button onClick={() => handleShipConfirm(p.planId, pa.prealertId, key)} disabled={opsActionSubmitting[key]} style={btnBlue}>{opsActionSubmitting[key] ? "..." : "确认发运"}</button>
                            </div>
                          </div>
                        );
                      })}
                    </Section>
                  )}

                  {/* --- 待泰国签收 --- */}
                  {p.sections.shipped.length > 0 && (
                    <Section title="泰国签收" count={p.sections.shipped.length} emptyMsg="">
                      {p.sections.shipped.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "#6b7280", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "#9ca3af", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "#6b7280", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "#b91c1c", background: "#fee2e2", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                          </div>
                          <div style={{ flexShrink: 0 }}>
                            <button onClick={() => setThailandTarget({ planId: p.planId, prealertId: pa.prealertId, planNo: p.planNo, trackingNo: pa.trackingNo, clientName: pa.clientName, volumeM3: pa.volumeM3 })} style={btnBlue}>上传签收单</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                </div>
              ))
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 3: 拼柜计划 */}
        {/* ================================================================ */}
        {activeTab === "plans" && (
          <>
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>拼柜计划</h3>
            {planLoading || detailLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> : (
              planDetail ? (
                <div>
                  <button onClick={() => { setPlanDetail(null); setSelectedPlanId(null); }} style={{ ...btnGray, marginBottom: 16 }}>← 返回列表</button>

                  <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <h4 style={{ margin: "0 0 8px" }}>{planDetail.planNo}</h4>
                    <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>{planDetail.warehouse} · {planDetail.containerType} · {planDetail.destinationTh} · {planDetail.totalVolumeM3}方 · <span style={{ padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "#e5e7eb", color: TAG[planDetail.status]?.color ?? "#374151", fontSize: 12 }}>{PLAN_ST_ZH[planDetail.status] ?? planDetail.status}</span></p>
                    <p style={{ fontSize: 12, color: "#9ca3af", margin: "4px 0 0" }}>创建人：{planDetail.creatorName} · {formatBeijingTime(planDetail.createdAt)}</p>
                  </div>

                  <h4 style={{ fontSize: 15, marginBottom: 12 }}>客户列表</h4>
                  {planDetail.customers.map((c: any) => (
                    <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong>{c.clientName}</strong>
                          <span style={{ fontSize: 13, color: "#6b7280", marginLeft: 8 }}>{c.clientPhone} · {c.clientCompany}</span>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, marginLeft: 8, background: "#f3f4f6", color: "#6b7280" }}>参与客户</span>
                        </div>
                        <span style={{ fontSize: 13, color: "#6b7280" }}>{c.totalVolumeM3}方 · {c.totalFee ? `¥${c.totalFee.toLocaleString()}` : ""}</span>
                      </div>
                      <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                        普货：{c.unitPriceNormal}元/方 · 商检：{c.unitPriceInspection}元/方 · 敏感：{c.unitPriceSensitive}元/方
                      </div>
                      {c.deliveryAddress && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>收货地址：{c.deliveryAddress}</div>}
                    </div>
                  ))}
                  {planDetail.customers.length === 0 && <p style={{ color: "#9ca3af", fontSize: 14, padding: "12px 0" }}>暂无客户</p>}
                </div>
              ) : (
                <>
                  {planList.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 14, padding: "12px 0" }}>暂无计划</p> : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "#f3f4f6" }}>
                          {["计划编号", "仓库", "柜型", "目的地", "总方数", "客户数", "状态", "创建人", "创建时间"].map(h => <th key={h} style={thS}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {planList.map(p => {
                          const isSelected = selectedPlanId === p.id;
                          return (
                          <tr key={p.id} onClick={() => { setSelectedPlanId(p.id); loadPlanDetail(p.id); }} style={{ cursor: "pointer", borderBottom: "1px solid #f3f4f6", background: isSelected ? "#eff6ff" : "white" }} onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")} onMouseLeave={e => (e.currentTarget.style.background = isSelected ? "#eff6ff" : "white")}>
                            <td style={{ ...tdS, fontWeight: 600 }}>{p.planNo}</td>
                            <td style={tdS}>{p.warehouse}</td>
                            <td style={tdS}>{p.containerType}</td>
                            <td style={tdS}>{p.destinationTh}</td>
                            <td style={tdS}>{p.totalVolumeM3}方</td>
                            <td style={tdS}>{p.customerCount}</td>
                            <td style={tdS}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 12, background: TAG[p.status]?.bg ?? "#e5e7eb", color: TAG[p.status]?.color ?? "#374151" }}>{PLAN_ST_ZH[p.status] ?? p.status}</span></td>
                            <td style={tdS}>{p.creatorName}</td>
                            <td style={{ ...tdS, fontSize: 12 }}>{formatBeijingTime(p.createdAt)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              )
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 弹窗：仓库签收 */}
        {/* ================================================================ */}
        {signTarget && (
          <Modal onClose={() => { setSignTarget(null); setSignFile(null); }}>
            <h3 style={{ marginTop: 0 }}>仓库签收</h3>
            <p style={{ fontSize: 13, color: "#6b7280" }}>{signTarget.planNo} · 预报单：{signTarget.trackingNo} · 唛头：{signTarget.mark || "-"}</p>
            <p style={{ fontSize: 13, color: "#374151" }}>
              客户：{signTarget.clientName}
              {signTarget.clientCompany && <span style={{ color: "#6b7280", marginLeft: 8 }}>{signTarget.clientCompany}</span>}
              {signTarget.clientPhone && <span style={{ color: "#6b7280", marginLeft: 8 }}>{signTarget.clientPhone}</span>}
            </p>
            {signTarget.deliveryAddress && <p style={{ fontSize: 12, color: "#6b7280" }}>收货地址：{signTarget.deliveryAddress}</p>}

            {/* 货品清单 */}
            {signTarget.loading ? (
              <p style={{ color: "#9ca3af", padding: "12px 0" }}>加载预报单详情...</p>
            ) : (
              (signTarget.items ?? []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>货品清单（{signTarget.items!.length}款）</div>
                  <div style={{ maxHeight: 300, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ background: "#f3f4f6" }}>
                        {["品名","件数","方数","材质","类型"].map(h => <th key={h} style={{ ...thS, padding: "3px 6px", fontSize: 10 }}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {signTarget.items!.map((it: any, idx: number) => (
                          <tr key={idx}>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? (typeof it.volumeM3 === "number" ? it.volumeM3.toFixed(4) : it.volumeM3) : "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.material || "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            <div style={{ marginTop: 14 }}>
              <label style={fl}>收货凭证照片 *</label>
              <input type="file" accept="image/*" onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                if (file.size > MAX_IMAGE_BYTES) {
                  setToast(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，请压缩后再上传`);
                  e.target.value = "";
                  return;
                }
                const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                setSignFile({ base64, fileName: file.name, mime: file.type });
              }} style={{ marginTop: 4 }} />
              {signFile && <div style={{ fontSize: 12, color: "#10b981", marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>已选择: {signFile.fileName}<button onClick={() => { if (window.confirm("确认删除已上传的收货凭证照片？")) { setSignFile(null); } }} style={{ padding: "1px 8px", border: "1px solid #ef4444", color: "#ef4444", background: "#fff", borderRadius: 3, cursor: "pointer", fontSize: 11 }}>删除凭证</button></div>}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleWarehouseSign} disabled={signSubmitting || !signFile} style={{ ...btnBlue, opacity: !signFile ? 0.5 : 1, cursor: !signFile ? "not-allowed" : "pointer" }}>
                {signSubmitting ? "提交中..." : "确认签收"}
              </button>
              <button onClick={() => { setSignTarget(null); setSignFile(null); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：审核付款 */}
        {/* ================================================================ */}
        {reviewTarget && (
          <Modal onClose={() => { setReviewTarget(null); setShowReject(false); }}>
            {showReject ? (
              <>
                <h3 style={{ marginTop: 0 }}>审核不通过</h3>
                <p style={{ fontSize: 13, color: "#6b7280" }}>预报单：{reviewTarget.prealert.trackingNo} · {reviewTarget.prealert.mark}</p>
                {reviewTarget.prealert.deliveryAddress && <p style={{ fontSize: 12, color: "#6b7280" }}>收货地址：{reviewTarget.prealert.deliveryAddress}</p>}
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>拒绝原因 *</label>
                  <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="请填写拒绝原因" style={{ ...fi, minHeight: 80 }} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>修改单价（可选，留空不修改）</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div><label style={{ fontSize: 11, color: "#6b7280" }}>普货单价</label><input type="number" value={rejectPriceNormal} onChange={e => setRejectPriceNormal(e.target.value)} placeholder="留空不修改" style={fi} /></div>
                    <div><label style={{ fontSize: 11, color: "#6b7280" }}>商检单价</label><input type="number" value={rejectPriceInspection} onChange={e => setRejectPriceInspection(e.target.value)} placeholder="留空不修改" style={fi} /></div>
                    <div><label style={{ fontSize: 11, color: "#6b7280" }}>敏感单价</label><input type="number" value={rejectPriceSensitive} onChange={e => setRejectPriceSensitive(e.target.value)} placeholder="留空不修改" style={fi} /></div>
                  </div>
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReviewReject} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
                  <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnGray}>取消</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>审核付款</h3>
                <div style={{ fontSize: 13 }}>
                  <p style={{ margin: "4px 0" }}>预报单：{reviewTarget.prealert.trackingNo} · 唛头：{reviewTarget.prealert.mark || "-"}</p>
                  <p style={{ margin: "4px 0" }}>客户：{reviewTarget.prealert.clientName}</p>
                  {reviewTarget.prealert.deliveryAddress && <p style={{ margin: "2px 0", color: "#6b7280" }}>收货地址：{reviewTarget.prealert.deliveryAddress}</p>}

                  {reviewTarget.prealert.totalFee != null && (
                    <p style={{ margin: "8px 0", fontSize: 16, fontWeight: 700, color: "#059669" }}>应付金额：{money(reviewTarget.prealert.totalFee)}</p>
                  )}

                  {/* 货品明细 */}
                  {reviewTarget.prealert.loading ? (
                    <p style={{ color: "#9ca3af", padding: "12px 0" }}>加载货品明细...</p>
                  ) : (
                    <>
                      {(reviewTarget.prealert.items ?? []).length > 0 && (
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
                      )}

                      {/* 费用明细 —— 直接用后端下发的，和结算口径一致；
                          前端自己按当前单价再算一遍会和已锁定的金额对不上 */}
                      <div style={{ marginTop: 8 }}>
                        <FeeBreakdownPanel bd={reviewTarget.prealert.feeBreakdown} title="费用是这样算出来的" />
                      </div>

                      {/* 付款截图 */}
                      {(() => {
                        const proofs = reviewTarget.prealert.paymentProofs;
                        if (!proofs || (Array.isArray(proofs) && proofs.length === 0)) return null;
                        const proofList = Array.isArray(proofs) ? proofs : [proofs];
                        return (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>付款截图（{proofList.length}张）</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {proofList.map((pf: any, idx: number) => {
                                const imgSrc = toImageSrc(pf?.base64Path || pf?.base64 || pf, pf?.mime);
                                if (!imgSrc) return null;
                                return <img key={idx} src={imgSrc} alt={`付款截图${idx + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />;
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReviewApprove} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "..." : "审核通过"}</button>
                  <button onClick={() => { setShowReject(true); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive(""); }} style={btnGray}>审核不通过</button>
                </div>
              </>
            )}
          </Modal>
        )}


        {/* ================================================================ */}
        {/* 弹窗：泰国签收 */}
        {/* ================================================================ */}
        {thailandTarget && (
          <Modal onClose={() => { setThailandTarget(null); setThailandFile(null); }}>
            <h3 style={{ marginTop: 0 }}>泰国签收 - {thailandTarget.clientName}</h3>
            <p style={{ fontSize: 13, color: "#6b7280" }}>{thailandTarget.planNo} · 预报单：{thailandTarget.trackingNo} · {thailandTarget.volumeM3}方</p>
            <div style={{ marginTop: 14 }}>
              <label style={fl}>签收单文件 *</label>
              <input type="file" accept="image/*" onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                if (file.size > MAX_IMAGE_BYTES) {
                  setToast(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，请压缩后再上传`);
                  e.target.value = "";
                  return;
                }
                const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                setThailandFile({ base64, fileName: file.name, mime: file.type });
              }} style={{ marginTop: 4 }} />
              {thailandFile && <div style={{ fontSize: 12, color: "#10b981", marginTop: 4 }}>已选择: {thailandFile.fileName}</div>}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleThailandSign} disabled={thailandSubmitting || !thailandFile} style={{ ...btnBlue, opacity: !thailandFile ? 0.5 : 1, cursor: !thailandFile ? "not-allowed" : "pointer" }}>
                {thailandSubmitting ? "提交中..." : "确认签收"}
              </button>
              <button onClick={() => { setThailandTarget(null); setThailandFile(null); }} style={btnGray}>取消</button>
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
// Section 组件
// ============================================================================
function Section({ title, count, emptyMsg, children }: { title: string; count: number; emptyMsg: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h4 style={{ fontSize: 15, margin: "0 0 10px", color: "#374151" }}>{title} ({count})</h4>
      {count === 0 ? <p style={{ fontSize: 14, color: "#9ca3af", padding: "12px 0" }}>{emptyMsg}</p> : children}
    </div>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
