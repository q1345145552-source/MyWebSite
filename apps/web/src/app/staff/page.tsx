"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import {
  approveStaffPrealert,
  createStaffOrder,
  fetchStaffPrealerts,
  fetchStaffShipments,
  type OrderItem,
  type ShipmentItem,
  updateStaffShipmentStatus,
} from "../../services/business-api";

export default function StaffHomePage() {
  type PrealertEditDraft = {
    warehouseId: string;
    itemName: string;
    packageCount: number;
    packageUnit: "bag" | "box";
    productQuantity: number;
    weightKg: number;
    volumeM3: number;
    domesticTrackingNo: string;
    transportMode: "sea" | "land";
    shipDate: string;
  };
  const clientOptions = [
    { id: "u_client_001", name: "Client One（客户一）" },
  ];
  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌" },
    { id: "wh_guangzhou_01", label: "广州" },
    { id: "wh_dongguan_01", label: "东莞" },
  ];
  const logisticsStatusOptions = ["已收货", "途中", "已到达"] as const;
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [prealertSearch, setPrealertSearch] = useState({
    clientName: "",
    domesticTrackingNo: "",
    transportMode: "",
    warehouseId: "",
  });
  const [prealertPanelCollapsed, setPrealertPanelCollapsed] = useState(false);
  const [shipmentListCollapsed, setShipmentListCollapsed] = useState(false);
  const [clientSearchKeyword, setClientSearchKeyword] = useState("");
  const [shipments, setShipments] = useState<ShipmentItem[]>([]);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);
  const [createStepDone, setCreateStepDone] = useState(false);
  const [statusSearch, setStatusSearch] = useState({
    batchNo: "",
    shipmentStatus: "",
  });
  const [statusHasSearched, setStatusHasSearched] = useState(false);
  const [editingShipmentId, setEditingShipmentId] = useState<string | null>(null);
  const [editingBatchNo, setEditingBatchNo] = useState<string | null>(null);
  const [statusEditDraft, setStatusEditDraft] = useState({
    toStatus: "",
    remark: "",
  });
  const [shipmentSearch, setShipmentSearch] = useState({
    batchNo: "",
    clientName: "",
    itemName: "",
    trackingNo: "",
    domesticTrackingNo: "",
    packageCount: "",
    productQuantity: "",
    weightKg: "",
    volumeM3: "",
    arrivedAt: "",
    warehouseId: "",
    logisticsStatus: "",
  });
  const [form, setForm] = useState({
    clientId: "u_client_001",
    warehouseId: "wh_yiwu_01",
    batchNo: "",
    trackingNo: "",
    arrivedAt: "",
    itemName: "",
    productQuantity: "",
    packageCount: "",
    volumeM3: "",
    weightKg: "",
    domesticOrderNo: "",
    packageUnit: "box" as "bag" | "box",
    transportMode: "land" as "sea" | "land",
    receiverNameTh: "Anan",
    receiverPhoneTh: "0820000000",
    receiverAddressTh: "Chiang Mai",
  });
  const buildPrealertDraft = (item: OrderItem): PrealertEditDraft => ({
    warehouseId: item.warehouseId ?? "",
    itemName: item.itemName,
    packageCount: item.packageCount,
    packageUnit: item.packageUnit === "bag" ? "bag" : "box",
    productQuantity: item.productQuantity,
    weightKg: item.weightKg ?? 0,
    volumeM3: item.volumeM3 ?? 0,
    domesticTrackingNo: item.domesticTrackingNo ?? "",
    transportMode: item.transportMode === "sea" ? "sea" : "land",
    shipDate: item.shipDate ?? item.createdAt.slice(0, 10),
  });

  const isSamePrealertDraft = (a: PrealertEditDraft, b: PrealertEditDraft): boolean =>
    a.warehouseId === b.warehouseId &&
    a.itemName === b.itemName &&
    a.packageCount === b.packageCount &&
    a.packageUnit === b.packageUnit &&
    a.productQuantity === b.productQuantity &&
    a.weightKg === b.weightKg &&
    a.volumeM3 === b.volumeM3 &&
    a.domesticTrackingNo === b.domesticTrackingNo &&
    a.transportMode === b.transportMode &&
    a.shipDate === b.shipDate;

  const validatePrealertDraft = (draft: PrealertEditDraft): string | null => {
    if (!draft.warehouseId) {
      return "仓库未选择，请选择义乌/广州/东莞。";
    }
    if (!draft.itemName.trim()) {
      return "品名不能为空。";
    }
    if (!Number.isFinite(draft.packageCount) || draft.packageCount <= 0) {
      return "箱数/袋数必须大于 0。";
    }
    if (draft.packageUnit !== "box" && draft.packageUnit !== "bag") {
      return "箱数/袋数单位无效，请选择箱或袋。";
    }
    if (!Number.isFinite(draft.productQuantity) || draft.productQuantity <= 0) {
      return "产品数量必须大于 0。";
    }
    if (!Number.isFinite(draft.weightKg) || draft.weightKg <= 0) {
      return "重量必须大于 0。";
    }
    if (!Number.isFinite(draft.volumeM3) || draft.volumeM3 <= 0) {
      return "体积必须大于 0。";
    }
    if (draft.transportMode !== "sea" && draft.transportMode !== "land") {
      return "运输方式无效，请选择海运或陆运。";
    }
    if (!draft.shipDate) {
      return "发货日期不能为空。";
    }
    const shipDate = new Date(`${draft.shipDate}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      return "发货日期格式无效，请重新选择日期。";
    }
    return null;
  };

  const toLogisticsStatus = (status?: string): "" | "已收货" | "途中" | "已到达" => {
    if (!status) return "";
    const v = status.trim();
    if (v === "delivered" || v === "returned" || v === "cancelled") return "已到达";
    if (v === "inTransit" || v === "customsTH" || v === "outForDelivery") return "途中";
    return "已收货";
  };

  const toSystemStatus = (logisticsStatus: string): string => {
    if (logisticsStatus === "已收货") return "created";
    if (logisticsStatus === "途中") return "inTransit";
    if (logisticsStatus === "已到达") return "delivered";
    return logisticsStatus;
  };

  const loadPageData = async () => {
    const [shipmentItems, prealertItems] = await Promise.all([fetchStaffShipments(), fetchStaffPrealerts()]);
    setShipments(shipmentItems);
    setPrealerts(prealertItems);
    setPrealertBatchDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = item.batchNo ?? "";
        }
      });
      return next;
    });
    setPrealertEditDrafts((prev) => {
      const next: Record<string, PrealertEditDraft> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = buildPrealertDraft(item);
        }
      });
      return next;
    });
    setPrealertConfirmedDrafts((prev) => {
      const next: Record<string, PrealertEditDraft> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = buildPrealertDraft(item);
        }
      });
      return next;
    });
  };

  useEffect(() => {
    setLoading(true);
    loadPageData()
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const submitOrder = async () => {
    const itemName = form.itemName.trim();
    const batchNo = form.batchNo.trim();
    const trackingNo = form.trackingNo.trim();
    const arrivedAt = form.arrivedAt.trim();
    const packageCount = Number(form.packageCount.trim());
    const productQuantityText = form.productQuantity.trim();
    const productQuantity = productQuantityText ? Number(productQuantityText) : undefined;
    const volumeM3 = Number(form.volumeM3.trim());
    const weightKg = Number(form.weightKg.trim());

    if (!itemName || !batchNo || !trackingNo || !arrivedAt) {
      setMessage("请先完整填写创建订单信息。");
      return;
    }
    if (
      Number.isNaN(packageCount) ||
      Number.isNaN(volumeM3) ||
      Number.isNaN(weightKg)
    ) {
      setMessage("数量、重量、体积请输入有效数字。");
      return;
    }
    if (productQuantityText && productQuantity !== undefined && Number.isNaN(productQuantity)) {
      setMessage("产品数量请输入有效数字，或留空。");
      return;
    }
    if (
      packageCount <= 0 ||
      (productQuantity !== undefined && productQuantity <= 0) ||
      volumeM3 <= 0 ||
      weightKg <= 0
    ) {
      setMessage("包裹数量、重量、体积必须大于 0；产品数量可留空或填写大于 0。");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const result = await createStaffOrder({
        clientId: form.clientId,
        warehouseId: form.warehouseId,
        batchNo,
        trackingNo,
        arrivedAt,
        itemName,
        productQuantity,
        packageCount,
        packageUnit: form.packageUnit,
        weightKg,
        volumeM3,
        domesticTrackingNo: form.domesticOrderNo.trim(),
        transportMode: form.transportMode,
        receiverNameTh: form.receiverNameTh,
        receiverPhoneTh: form.receiverPhoneTh,
        receiverAddressTh: form.receiverAddressTh,
      });
      setCreateStepDone(true);
      setToast("订单创建成功");
      setMessage(`订单创建成功：${result.orderId}`);
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "创建失败";
      setMessage(`创建失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitStatusUpdate = async (shipmentId: string) => {
    const toStatus = toSystemStatus(statusEditDraft.toStatus.trim());
    const remark = statusEditDraft.remark.trim();
    if (!toStatus) {
      setMessage("请先选择物流状态。");
      return;
    }
    if (!remark) {
      setMessage("请先填写编辑信息。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStaffShipmentStatus({
        shipmentId,
        toStatus,
        remark,
      });
      setToast("运单状态更新成功");
      setMessage(
        result.mode === "batch"
          ? `批次 ${result.batchNo ?? "-"} 更新成功，共 ${result.updatedCount} 条 -> ${result.toStatus}`
          : `状态更新成功：${result.fromStatus ?? "-"} -> ${result.toStatus}`,
      );
      setEditingShipmentId(null);
      setStatusEditDraft({ toStatus: "", remark: "" });
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "更新失败";
      setMessage(`更新失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitBatchStatusUpdate = async (batchNo: string) => {
    const targetBatchNo = batchNo.trim();
    const toStatus = toSystemStatus(statusEditDraft.toStatus.trim());
    const remark = statusEditDraft.remark.trim();
    if (!targetBatchNo) {
      setMessage("请先输入柜号并搜索。");
      return;
    }
    if (!toStatus) {
      setMessage("请先选择物流状态。");
      return;
    }
    if (!remark) {
      setMessage("请先填写编辑信息。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStaffShipmentStatus({
        batchNo: targetBatchNo,
        updateByBatch: true,
        toStatus,
        remark,
      });
      setToast("批量状态更新成功");
      setMessage(`批次 ${result.batchNo ?? targetBatchNo} 更新成功，共 ${result.updatedCount} 条 -> ${result.toStatus}`);
      setEditingBatchNo(null);
      setStatusEditDraft({ toStatus: "", remark: "" });
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "更新失败";
      setMessage(`更新失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const approvePrealert = async (orderId: string) => {
    const sourceItem = prealerts.find((item) => item.id === orderId);
    const currentDraft = prealertEditDrafts[orderId] ?? (sourceItem ? buildPrealertDraft(sourceItem) : undefined);
    const confirmedDraft = prealertConfirmedDrafts[orderId] ?? currentDraft;
    if (!currentDraft || !confirmedDraft) {
      setMessage("未找到预报单草稿，请刷新后重试。");
      return;
    }
    const confirmedDraftError = validatePrealertDraft(confirmedDraft);
    if (confirmedDraftError) {
      setMessage(`审核失败：${confirmedDraftError}`);
      return;
    }
    if (editingPrealertId === orderId && !isSamePrealertDraft(currentDraft, confirmedDraft)) {
      setMessage("你还有未确认的修改，请先点击“确认修改”。");
      return;
    }

    const batchNo = (prealertBatchDrafts[orderId] ?? "").trim();
    if (!batchNo) {
      setMessage("请先填写批次号后再审核通过。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const draft = confirmedDraft;
      await approveStaffPrealert({
        orderId,
        batchNo,
        warehouseId: draft?.warehouseId,
        itemName: draft?.itemName,
        packageCount: draft?.packageCount,
        packageUnit: draft?.packageUnit,
        productQuantity: draft?.productQuantity,
        weightKg: draft?.weightKg,
        volumeM3: draft?.volumeM3,
        domesticTrackingNo: draft?.domesticTrackingNo,
        transportMode: draft?.transportMode,
        shipDate: draft?.shipDate,
      });
      setEditingPrealertId((current) => (current === orderId ? null : current));
      setToast("预报单审核通过");
      setMessage(`预报单 ${orderId} 已审核通过，批次号 ${batchNo} 已回写到客户订单列表。`);
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "审核失败";
      setMessage(`审核失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const confirmPrealertEdit = (orderId: string) => {
    const draft = prealertEditDrafts[orderId];
    if (!draft) {
      setMessage("未找到可确认的修改内容。");
      return;
    }
    const draftError = validatePrealertDraft(draft);
    if (draftError) {
      setMessage(`确认修改失败：${draftError}`);
      return;
    }
    setPrealertConfirmedDrafts((prev) => ({ ...prev, [orderId]: draft }));
    setEditingPrealertId(null);
    setToast("修改已确认");
    setMessage(`预报单 ${orderId} 修改已确认。`);
  };

  const FieldCard = ({
    label,
    children,
  }: {
    label: string;
    children: ReactNode;
  }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: 10,
        background: "#ffffff",
      }}
    >
      <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );

  const InfoItem = ({ label, value }: { label: string; value: string }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#f9fafb",
        padding: "8px 10px",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 13, color: "#1f2937", fontWeight: 600 }}>{value}</div>
    </div>
  );

  const prealertEditInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 10px",
    width: "100%",
    marginBottom: 8,
  } as const;

  const allClientOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    clientOptions.forEach((item) => byId.set(item.id, item));
    prealerts.forEach((item) => {
      if (!item.clientId) return;
      const current = byId.get(item.clientId);
      if (current) return;
      byId.set(item.clientId, {
        id: item.clientId,
        name: item.clientName ?? item.clientId,
      });
    });
    return Array.from(byId.values());
  }, [prealerts]);

  const filteredClientOptions = useMemo(() => {
    const keyword = clientSearchKeyword.trim().toLowerCase();
    if (!keyword) return allClientOptions;
    return allClientOptions.filter(
      (item) => item.name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword),
    );
  }, [allClientOptions, clientSearchKeyword]);

  const filteredPrealerts = useMemo(() => {
    const clientKeyword = prealertSearch.clientName.trim().toLowerCase();
    const domesticKeyword = prealertSearch.domesticTrackingNo.trim().toLowerCase();
    return prealerts
      .filter((item) => {
        const clientText = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
        return !clientKeyword || clientText.includes(clientKeyword);
      })
      .filter((item) => {
        const domesticText = (item.domesticTrackingNo ?? "").toLowerCase();
        return !domesticKeyword || domesticText.includes(domesticKeyword);
      })
      .filter((item) => !prealertSearch.warehouseId || item.warehouseId === prealertSearch.warehouseId)
      .filter((item) => !prealertSearch.transportMode || item.transportMode === prealertSearch.transportMode);
  }, [prealerts, prealertSearch]);

  const filteredStatusShipments = useMemo(() => {
    if (!statusHasSearched) return [];
    const batchNoKeyword = statusSearch.batchNo.trim().toLowerCase();
    const shipmentStatusKeyword = statusSearch.shipmentStatus.trim();
    return shipments.filter((item) => {
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const logisticsStatus = toLogisticsStatus(item.currentStatus);
      const batchMatched = !batchNoKeyword || batchNo.includes(batchNoKeyword);
      const statusMatched = !shipmentStatusKeyword || logisticsStatus === shipmentStatusKeyword;
      return batchMatched && statusMatched;
    });
  }, [shipments, statusHasSearched, statusSearch]);

  const searchedBatchNo = useMemo(() => statusSearch.batchNo.trim(), [statusSearch.batchNo]);
  const exactBatchNo = useMemo(() => {
    if (!searchedBatchNo) return "";
    const exact = filteredStatusShipments.find(
      (item) => (item.batchNo ?? "").trim().toLowerCase() === searchedBatchNo.toLowerCase(),
    );
    return (exact?.batchNo ?? "").trim();
  }, [filteredStatusShipments, searchedBatchNo]);
  const batchNoForBulkEdit = exactBatchNo || searchedBatchNo;
  const canSubmitBatchEdit = Boolean(statusEditDraft.toStatus.trim()) && Boolean(statusEditDraft.remark.trim());

  const filteredShipmentList = useMemo(() => {
    const batchNoKeyword = shipmentSearch.batchNo.trim().toLowerCase();
    const clientNameKeyword = shipmentSearch.clientName.trim().toLowerCase();
    const itemNameKeyword = shipmentSearch.itemName.trim().toLowerCase();
    const trackingNoKeyword = shipmentSearch.trackingNo.trim().toLowerCase();
    const domesticTrackingKeyword = shipmentSearch.domesticTrackingNo.trim().toLowerCase();
    const packageCountKeyword = shipmentSearch.packageCount.trim();
    const productQuantityKeyword = shipmentSearch.productQuantity.trim();
    const weightKgKeyword = shipmentSearch.weightKg.trim();
    const volumeM3Keyword = shipmentSearch.volumeM3.trim();
    const arrivedAtKeyword = shipmentSearch.arrivedAt.trim();
    const warehouseKeyword = shipmentSearch.warehouseId.trim();
    const logisticsStatusKeyword = shipmentSearch.logisticsStatus.trim();

    return shipments.filter((item) => {
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const clientName = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
      const itemName = (item.itemName ?? "").toLowerCase();
      const trackingNo = (item.trackingNo ?? "").toLowerCase();
      const domesticTrackingNo = (item.domesticTrackingNo ?? "").toLowerCase();
      const packageCount = item.packageCount == null ? "" : String(item.packageCount);
      const productQuantity = item.productQuantity == null ? "" : String(item.productQuantity);
      const weightKg = item.weightKg == null ? "" : String(item.weightKg);
      const volumeM3 = item.volumeM3 == null ? "" : String(item.volumeM3);
      const arrivedAt = item.arrivedAt ? item.arrivedAt.slice(0, 10) : "";
      const warehouseId = (item.warehouseId ?? "").toLowerCase();
      const logisticsStatus = toLogisticsStatus(item.currentStatus);

      if (batchNoKeyword && !batchNo.includes(batchNoKeyword)) return false;
      if (clientNameKeyword && !clientName.includes(clientNameKeyword)) return false;
      if (itemNameKeyword && !itemName.includes(itemNameKeyword)) return false;
      if (trackingNoKeyword && !trackingNo.includes(trackingNoKeyword)) return false;
      if (domesticTrackingKeyword && !domesticTrackingNo.includes(domesticTrackingKeyword)) return false;
      if (packageCountKeyword && !packageCount.includes(packageCountKeyword)) return false;
      if (productQuantityKeyword && !productQuantity.includes(productQuantityKeyword)) return false;
      if (weightKgKeyword && !weightKg.includes(weightKgKeyword)) return false;
      if (volumeM3Keyword && !volumeM3.includes(volumeM3Keyword)) return false;
      if (arrivedAtKeyword && !arrivedAt.includes(arrivedAtKeyword)) return false;
      if (warehouseKeyword && warehouseId !== warehouseKeyword.toLowerCase()) return false;
      if (logisticsStatusKeyword && logisticsStatus !== logisticsStatusKeyword) return false;
      return true;
    });
  }, [shipments, shipmentSearch]);

  const orderCreateInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 10px",
    width: "100%",
    marginBottom: 8,
  } as const;

  const exportShipmentsToExcel = () => {
    if (filteredShipmentList.length === 0) {
      setMessage("当前没有可导出的运单数据。");
      return;
    }
    const rows = filteredShipmentList.map((item) => ({
      客户名: item.clientName ?? item.clientId ?? "-",
      柜号: item.batchNo ?? "-",
      品名: item.itemName ?? "-",
      湘泰运单号: item.trackingNo ?? "-",
      国内单号: item.domesticTrackingNo ?? "-",
      包裹数量: item.packageCount ?? "-",
      产品数量: item.productQuantity ?? "-",
      重量kg: item.weightKg ?? "-",
      体积m3: item.volumeM3 ?? "-",
      到仓日期: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "-",
      国内仓库: item.warehouseId ?? "-",
      物流状态: toLogisticsStatus(item.currentStatus) || "-",
      可编辑: item.canEdit ? "是" : "否",
      更新时间: item.updatedAt ?? "-",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "运单列表");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `运单列表_${today}.xlsx`);
    setToast("导出Excel成功");
  };

  return (
    <RoleShell allowedRole="staff" title="员工工作台">
      <p style={{ color: "#4b5563", marginBottom: 16 }}>
        员工可创建订单、查看运单、并按状态流转规则更新状态。
      </p>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>客户预报单审核</h2>
          <button
            type="button"
            onClick={() => setPrealertPanelCollapsed((v) => !v)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#374151",
              background: "#fff",
              fontWeight: 600,
            }}
          >
            {prealertPanelCollapsed ? "展开" : "折叠"}
          </button>
        </div>
        {!prealertPanelCollapsed ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <input
                value={prealertSearch.clientName}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, clientName: e.target.value }))}
                placeholder="按客户名字查找"
                style={orderCreateInputStyle}
              />
              <input
                value={prealertSearch.domesticTrackingNo}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, domesticTrackingNo: e.target.value }))}
                placeholder="按国内快递单号查找"
                style={orderCreateInputStyle}
              />
              <select
                value={prealertSearch.warehouseId}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, warehouseId: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">仓库（全部）</option>
                <option value="wh_yiwu_01">义乌</option>
                <option value="wh_guangzhou_01">广州</option>
                <option value="wh_dongguan_01">东莞</option>
              </select>
              <select
                value={prealertSearch.transportMode}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, transportMode: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
            </div>
            {prealerts.length === 0 ? (
              <EmptyStateCard title="暂无待审核预报单" description="客户提交预报单后会在这里显示，审核通过后会自动移出。" />
            ) : filteredPrealerts.length === 0 ? (
              <EmptyStateCard title="未找到匹配预报单" description="可调整客户名字、国内快递单号、仓库或运输方式筛选条件。" />
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {filteredPrealerts.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                    {(() => {
                      const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                      const isEditing = editingPrealertId === item.id;
                      const confirmedDraft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
                      const displayDraft = isEditing ? draft : confirmedDraft;
                      return (
                        <>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      客户名字：{item.clientName ?? item.clientId ?? "-"} / 提交日期：{item.createdAt.slice(0, 10)}
                    </div>
                    <div
                      style={{
                        marginBottom: 8,
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      {isEditing ? (
                        <>
                          <select
                            value={draft.warehouseId}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  warehouseId: e.target.value,
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="">请选择仓库</option>
                            {warehouseOptions.map((warehouse) => (
                              <option key={warehouse.id} value={warehouse.id}>
                                仓库：{warehouse.label}
                              </option>
                            ))}
                          </select>
                          <input
                            value={draft.itemName}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), itemName: e.target.value },
                              }))
                            }
                            placeholder="品名"
                            style={prealertEditInputStyle}
                          />
                          <input
                            type="number"
                            value={String(draft.packageCount)}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  packageCount: Number(e.target.value || 0),
                                },
                              }))
                            }
                            placeholder="箱数/袋数"
                            style={prealertEditInputStyle}
                          />
                          <select
                            value={draft.packageUnit}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  packageUnit: e.target.value as "bag" | "box",
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="box">箱（box）</option>
                            <option value="bag">袋（bag）</option>
                          </select>
                          <input
                            type="number"
                            value={String(draft.productQuantity)}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  productQuantity: Number(e.target.value || 0),
                                },
                              }))
                            }
                            placeholder="产品数量"
                            style={prealertEditInputStyle}
                          />
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={String(draft.weightKg)}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    weightKg: Number(e.target.value || 0),
                                  },
                                }))
                              }
                              placeholder="重量"
                              style={{ ...prealertEditInputStyle, marginBottom: 0 }}
                            />
                            <span style={{ color: "#6b7280", fontSize: 13, minWidth: 26 }}>kg</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input
                              type="number"
                              step="0.001"
                              min="0.001"
                              value={String(draft.volumeM3)}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    volumeM3: Number(e.target.value || 0),
                                  },
                                }))
                              }
                              placeholder="体积"
                              style={{ ...prealertEditInputStyle, marginBottom: 0 }}
                            />
                            <span style={{ color: "#6b7280", fontSize: 13, minWidth: 30 }}>m3</span>
                          </div>
                          <input
                            value={draft.domesticTrackingNo}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  domesticTrackingNo: e.target.value,
                                },
                              }))
                            }
                            placeholder="国内快递单号"
                            style={prealertEditInputStyle}
                          />
                          <select
                            value={draft.transportMode}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  transportMode: e.target.value as "sea" | "land",
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="sea">运输方式：海运</option>
                            <option value="land">运输方式：陆运</option>
                          </select>
                          <input
                            type="date"
                            value={draft.shipDate}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), shipDate: e.target.value },
                              }))
                            }
                            style={prealertEditInputStyle}
                          />
                        </>
                      ) : (
                        <>
                          <InfoItem label="品名" value={displayDraft.itemName} />
                      <InfoItem
                        label="仓库"
                        value={
                          warehouseOptions.find((warehouse) => warehouse.id === displayDraft.warehouseId)?.label ??
                          displayDraft.warehouseId ??
                          "-"
                        }
                      />
                          <InfoItem label="箱数/袋数" value={`${displayDraft.packageCount} ${displayDraft.packageUnit}`} />
                          <InfoItem label="产品数量" value={String(displayDraft.productQuantity)} />
                          <InfoItem label="重量" value={`${displayDraft.weightKg ?? "-"} kg`} />
                          <InfoItem label="体积" value={`${displayDraft.volumeM3 ?? "-"} m3`} />
                          <InfoItem label="国内快递单号" value={displayDraft.domesticTrackingNo ?? "-"} />
                          <InfoItem label="运输方式" value={displayDraft.transportMode === "sea" ? "海运" : "陆运"} />
                          <InfoItem label="发货日期" value={displayDraft.shipDate} />
                        </>
                      )}
                    </div>
                    <input
                      value={prealertBatchDrafts[item.id] ?? ""}
                      onChange={(e) =>
                        setPrealertBatchDrafts((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      placeholder="填写批次号（例如 CAB-2026-A08）"
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void confirmPrealertEdit(item.id)}
                            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151", fontWeight: 600 }}
                          >
                            确认修改
                          </button>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => {
                              const sourceItem = prealerts.find((prealert) => prealert.id === item.id);
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: prealertConfirmedDrafts[item.id] ?? (sourceItem ? buildPrealertDraft(sourceItem) : prev[item.id]),
                              }));
                              setEditingPrealertId(null);
                            }}
                            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#374151", background: "#fff", fontWeight: 600 }}
                          >
                            取消修改
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            const sourceItem = prealerts.find((prealert) => prealert.id === item.id);
                            setPrealertEditDrafts((prev) => ({
                              ...prev,
                              [item.id]:
                                prealertConfirmedDrafts[item.id] ??
                                prev[item.id] ??
                                (sourceItem ? buildPrealertDraft(sourceItem) : buildPrealertDraft(item)),
                            }));
                            setEditingPrealertId(item.id);
                          }}
                          style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#374151", background: "#fff", fontWeight: 600 }}
                        >
                          修改
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void approvePrealert(item.id)}
                        style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151", fontWeight: 600 }}
                      >
                        审核通过
                      </button>
                    </div>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>创建订单（员工）</h2>
        <div style={{ display: "grid", gap: 0, maxWidth: 760 }}>
          <input
            value={clientSearchKeyword}
            onChange={(e) => setClientSearchKeyword(e.target.value)}
            placeholder="搜索客户名字或客户ID（可选）"
            style={orderCreateInputStyle}
          />
          <select
            value={form.clientId}
            onChange={(e) => setForm((v) => ({ ...v, clientId: e.target.value }))}
            style={orderCreateInputStyle}
          >
            {filteredClientOptions.length === 0 ? (
              <option value={form.clientId}>未找到匹配客户，请调整搜索关键词</option>
            ) : (
              filteredClientOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  客户名字：{item.name}
                </option>
              ))
            )}
          </select>
          <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={orderCreateInputStyle} />
          <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名" style={orderCreateInputStyle} />
          <input value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="湘泰运单号" style={orderCreateInputStyle} />
          <input value={form.domesticOrderNo} onChange={(e) => setForm((v) => ({ ...v, domesticOrderNo: e.target.value }))} placeholder="国内单号" style={orderCreateInputStyle} />
          <input type="number" value={form.packageCount} onChange={(e) => setForm((v) => ({ ...v, packageCount: e.target.value }))} placeholder="包裹数量" style={orderCreateInputStyle} />
          <input type="number" value={form.productQuantity} onChange={(e) => setForm((v) => ({ ...v, productQuantity: e.target.value }))} placeholder="产品数量（可不填）" style={orderCreateInputStyle} />
          <input type="number" step="0.01" value={form.weightKg} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量（kg）" style={orderCreateInputStyle} />
          <input type="number" step="0.001" value={form.volumeM3} onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="体积（m3）" style={orderCreateInputStyle} />
          <div style={{ display: "grid", gap: 4 }}>
            <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} style={orderCreateInputStyle} />
            <div style={{ fontSize: 12, color: "#64748b", marginTop: -6, marginBottom: 8 }}>说明：该日期为到仓日期</div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151" }}>
            创建订单
          </button>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>更新订单状态（员工）</h2>
        <div style={{ display: "grid", gap: 8, maxWidth: 760, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <input
            value={statusSearch.batchNo}
            onChange={(e) => setStatusSearch((v) => ({ ...v, batchNo: e.target.value }))}
            placeholder="柜号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
          <select
            value={statusSearch.shipmentStatus}
            onChange={(e) => setStatusSearch((v) => ({ ...v, shipmentStatus: e.target.value }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          >
            <option value="">物流状态（全部）</option>
            {logisticsStatusOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setStatusHasSearched(true);
              setEditingShipmentId(null);
              setEditingBatchNo(null);
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#4b5563" }}
          >
            搜索
          </button>
          <button
            type="button"
            onClick={() => {
              setStatusSearch({ batchNo: "", shipmentStatus: "" });
              setStatusHasSearched(false);
              setEditingShipmentId(null);
              setEditingBatchNo(null);
              setStatusEditDraft({ toStatus: "", remark: "" });
            }}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
          >
            清空
          </button>
        </div>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {statusHasSearched && searchedBatchNo && filteredStatusShipments.length > 0 ? (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ color: "#334155", fontWeight: 600 }}>
                  当前柜号：{batchNoForBulkEdit}（共 {filteredStatusShipments.length} 条）
                </div>
                <button
                  type="button"
                  disabled={loading || !exactBatchNo}
                  onClick={() => {
                    setEditingShipmentId(null);
                    setEditingBatchNo(batchNoForBulkEdit);
                    setStatusEditDraft({ toStatus: "", remark: "" });
                  }}
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    padding: "6px 12px",
                    background: "#fff",
                    fontWeight: 600,
                    color: "#374151",
                    cursor: loading || !exactBatchNo ? "not-allowed" : "pointer",
                    opacity: loading || !exactBatchNo ? 0.55 : 1,
                  }}
                >
                  按当前柜号批量状态修改
                </button>
              </div>
              {!exactBatchNo ? (
                <div style={{ marginTop: 8, color: "#b45309", fontSize: 13 }}>
                  提示：当前是模糊匹配，建议输入完整柜号后再执行批量修改。
                </div>
              ) : null}
              {editingBatchNo ? (
                <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <select
                    value={statusEditDraft.toStatus}
                    onChange={(e) => setStatusEditDraft((v) => ({ ...v, toStatus: e.target.value }))}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
                  >
                    <option value="">选择物流状态</option>
                    {logisticsStatusOptions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={statusEditDraft.remark}
                    onChange={(e) => setStatusEditDraft((v) => ({ ...v, remark: e.target.value }))}
                    placeholder="编辑信息（手动输入，必填）"
                    rows={3}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void submitBatchStatusUpdate(editingBatchNo)}
                      style={{
                        border: "none",
                        borderRadius: 8,
                        padding: "8px 14px",
                        color: "#fff",
                        background: "#4b5563",
                        cursor: loading ? "not-allowed" : "pointer",
                        opacity: loading ? 0.55 : 1,
                      }}
                    >
                      确认批量修改
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => {
                        setEditingBatchNo(null);
                        setStatusEditDraft({ toStatus: "", remark: "" });
                      }}
                      style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
                    >
                      取消
                    </button>
                  </div>
                  {!canSubmitBatchEdit ? (
                    <div style={{ color: "#b45309", fontSize: 13 }}>
                      可直接点击“确认批量修改”，系统会提示你缺少的必填项。
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!statusHasSearched ? (
            <EmptyStateCard title="请先搜索" description="输入柜号和物流状态后点击“搜索”。" />
          ) : filteredStatusShipments.length === 0 ? (
            <EmptyStateCard title="无匹配结果" description="可调整柜号或物流状态后重新搜索。" />
          ) : (
            filteredStatusShipments.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 14, color: "#374151", fontWeight: 600 }}>
                    <span>柜号：{item.batchNo ?? "-"}</span>
                    <span>物流状态：{toLogisticsStatus(item.currentStatus) || "-"}</span>
                  </div>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setEditingBatchNo(null);
                      setEditingShipmentId(item.id);
                      setStatusEditDraft({ toStatus: toLogisticsStatus(item.currentStatus), remark: "" });
                    }}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", fontWeight: 600, color: "#374151" }}
                  >
                    状态修改
                  </button>
                </div>
                {editingShipmentId === item.id ? (
                  <div style={{ marginTop: 10, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                    <select
                      value={statusEditDraft.toStatus}
                      onChange={(e) => setStatusEditDraft((v) => ({ ...v, toStatus: e.target.value }))}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
                    >
                      <option value="">选择物流状态</option>
                      {logisticsStatusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={statusEditDraft.remark}
                      onChange={(e) => setStatusEditDraft((v) => ({ ...v, remark: e.target.value }))}
                      placeholder="编辑信息（手动输入，必填）"
                      rows={3}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void submitStatusUpdate(item.id)}
                        style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#4b5563" }}
                      >
                        确认修改
                      </button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setEditingShipmentId(null);
                          setStatusEditDraft({ toStatus: "", remark: "" });
                        }}
                        style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>运单列表</h2>
          <button
            type="button"
            onClick={() => setShipmentListCollapsed((v) => !v)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#374151",
              background: "#fff",
              fontWeight: 600,
            }}
          >
            {shipmentListCollapsed ? "展开" : "折叠"}
          </button>
        </div>
        {!shipmentListCollapsed ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <input
                value={shipmentSearch.batchNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, batchNo: e.target.value }))}
                placeholder="柜号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.clientName}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, clientName: e.target.value }))}
                placeholder="客户名"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.itemName}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, itemName: e.target.value }))}
                placeholder="品名"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.trackingNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, trackingNo: e.target.value }))}
                placeholder="湘泰运单号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.domesticTrackingNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, domesticTrackingNo: e.target.value }))}
                placeholder="国内单号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.packageCount}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, packageCount: e.target.value }))}
                placeholder="包裹数量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.productQuantity}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, productQuantity: e.target.value }))}
                placeholder="产品数量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.weightKg}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, weightKg: e.target.value }))}
                placeholder="重量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.volumeM3}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, volumeM3: e.target.value }))}
                placeholder="体积"
                style={orderCreateInputStyle}
              />
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  type="date"
                  className="staff-shipment-date-input"
                  value={shipmentSearch.arrivedAt}
                  onChange={(e) => setShipmentSearch((prev) => ({ ...prev, arrivedAt: e.target.value }))}
                  style={{ ...orderCreateInputStyle, padding: "8px 64px 8px 10px", boxSizing: "border-box", marginBottom: 0 }}
                />
                {!shipmentSearch.arrivedAt ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "#94a3b8",
                      pointerEvents: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    到仓日期
                  </div>
                ) : null}
              </div>
              <select
                value={shipmentSearch.warehouseId}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, warehouseId: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">国内仓库（全部）</option>
                {warehouseOptions.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.label}
                  </option>
                ))}
              </select>
              <select
                value={shipmentSearch.logisticsStatus}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, logisticsStatus: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">物流状态（全部）</option>
                {logisticsStatusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() =>
                  setShipmentSearch({
                    batchNo: "",
                    clientName: "",
                    itemName: "",
                    trackingNo: "",
                    domesticTrackingNo: "",
                    packageCount: "",
                    productQuantity: "",
                    weightKg: "",
                    volumeM3: "",
                    arrivedAt: "",
                    warehouseId: "",
                    logisticsStatus: "",
                  })
                }
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
              >
                清空筛选
              </button>
              <button
                type="button"
                onClick={exportShipmentsToExcel}
                disabled={filteredShipmentList.length === 0}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 14px",
                  color: "#fff",
                  background: filteredShipmentList.length === 0 ? "#94a3b8" : "#2563eb",
                  cursor: filteredShipmentList.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                导出Excel
              </button>
            </div>
            <div style={{ marginBottom: 10, color: "#475569", fontSize: 13 }}>
              搜索结果数量：共 {filteredShipmentList.length} 条
            </div>
            {shipments.length === 0 ? (
              <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
            ) : filteredShipmentList.length === 0 ? (
              <EmptyStateCard title="没有匹配结果" description="请调整搜索条件后重试。" />
            ) : null}
            {filteredShipmentList.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10, background: "#fff" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>客户名：{item.clientName ?? item.clientId ?? "-"}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 6 }}>
                  <InfoItem label="柜号" value={item.batchNo ?? "-"} />
                  <InfoItem label="品名" value={item.itemName ?? "-"} />
                  <InfoItem label="湘泰运单号" value={item.trackingNo ?? "-"} />
                  <InfoItem label="国内单号" value={item.domesticTrackingNo ?? "-"} />
                  <InfoItem label="包裹数量" value={String(item.packageCount ?? "-")} />
                  <InfoItem label="产品数量" value={String(item.productQuantity ?? "-")} />
                  <InfoItem label="重量" value={`${item.weightKg ?? "-"} kg`} />
                  <InfoItem label="体积" value={`${item.volumeM3 ?? "-"} m3`} />
                  <InfoItem label="到仓日期" value={item.arrivedAt ? item.arrivedAt.slice(0, 10) : "-"} />
                  <InfoItem label="仓库" value={item.warehouseId ?? "-"} />
                  <InfoItem label="可编辑" value={item.canEdit ? "是" : "否"} />
                  <InfoItem label="更新时间" value={item.updatedAt ?? "-"} />
                </div>
              </div>
            ))}
          </>
        ) : null}
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
