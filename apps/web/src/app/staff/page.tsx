"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import StepGuide from "../../modules/layout/StepGuide";
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
  const [clientSearchKeyword, setClientSearchKeyword] = useState("");
  const [shipments, setShipments] = useState<ShipmentItem[]>([]);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);
  const [createStepDone, setCreateStepDone] = useState(false);
  const [statusStepDone, setStatusStepDone] = useState(false);
  const [form, setForm] = useState({
    clientId: "u_client_001",
    warehouseId: "wh_bkk_01",
    batchNo: "CAB-2026-A01",
    trackingNo: "XT00010001",
    arrivedAt: new Date().toISOString().slice(0, 10),
    itemName: "耳机",
    productQuantity: "",
    packageCount: "4",
    volumeM3: "0.2",
    weightKg: "18.5",
    domesticOrderNo: "SF77889900",
    packageUnit: "box" as "bag" | "box",
    transportMode: "land" as "sea" | "land",
    receiverNameTh: "Anan",
    receiverPhoneTh: "0820000000",
    receiverAddressTh: "Chiang Mai",
  });
  const [statusForm, setStatusForm] = useState({
    shipmentId: "s_001",
    batchNo: "CAB-2026-A01",
    updateByBatch: false,
    toStatus: "customsTH",
    remark: "staff update",
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

  const submitStatusUpdate = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStaffShipmentStatus(statusForm);
      setStatusStepDone(true);
      setToast("运单状态更新成功");
      setMessage(
        result.mode === "batch"
          ? `批次 ${result.batchNo ?? "-"} 更新成功，共 ${result.updatedCount} 条 -> ${result.toStatus}`
          : `状态更新成功：${result.fromStatus ?? "-"} -> ${result.toStatus}`,
      );
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

  const orderCreateInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 10px",
    width: "100%",
    marginBottom: 8,
  } as const;

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
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>1. 客户预报单审核</h2>
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
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>2. 创建订单（员工）</h2>
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
          <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} placeholder="到仓日期" style={orderCreateInputStyle} />
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
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>3. 更新订单状态（员工）</h2>
        <StepGuide
          steps={["选择单号或批次", "选择目标状态", "提交并记录痕迹"]}
          completedSteps={statusStepDone ? [0, 1, 2] : []}
        />
        <div style={{ display: "grid", gap: 8, maxWidth: 900, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <FieldCard label="更新模式">
            <label style={{ color: "#475569", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={statusForm.updateByBatch}
                onChange={(e) => setStatusForm((v) => ({ ...v, updateByBatch: e.target.checked }))}
              />
              按柜号/批次同步更新
            </label>
          </FieldCard>
          {statusForm.updateByBatch ? (
            <FieldCard label="柜号/批次">
              <input value={statusForm.batchNo} onChange={(e) => setStatusForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="例如 CAB-2026-A01" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }} />
            </FieldCard>
          ) : (
            <FieldCard label="运单ID">
              <input value={statusForm.shipmentId} onChange={(e) => setStatusForm((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="shipmentId" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }} />
            </FieldCard>
          )}
          <FieldCard label="目标状态">
            <input value={statusForm.toStatus} onChange={(e) => setStatusForm((v) => ({ ...v, toStatus: e.target.value }))} placeholder="toStatus" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }} />
          </FieldCard>
          <FieldCard label="备注">
            <input value={statusForm.remark} onChange={(e) => setStatusForm((v) => ({ ...v, remark: e.target.value }))} placeholder="remark" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }} />
          </FieldCard>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" disabled={loading} onClick={() => void submitStatusUpdate()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#4b5563" }}>
            更新状态
          </button>
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
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>4. 运单列表</h2>
        <StepGuide steps={["查看仓库范围数据", "确认状态是否可编辑", "继续流转下一节点"]} />
        {shipments.length === 0 ? (
          <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
        ) : null}
        {shipments.map((item) => (
          <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10, background: "#fff" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{item.id} / 状态：{item.currentStatus}</div>
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
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
