"use client";

import { useEffect, useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import { formatCny } from "../../modules/billing/billing-utils";
import { sendAiMessage } from "../../services/ai-client";
import {
  createClientPrealert,
  fetchClientPrealerts,
  fetchClientOrders,
  type OrderItem,
} from "../../services/business-api";

const initialSearch = {
  batchNo: "",
  orderId: "",
  arrivedDate: "",
  domesticTrackingNo: "",
  status: "",
  transportMode: "",
  warehouseId: "",
};

const warehouseOptions = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
];

const warehouseAddressMap: Record<string, string> = {
  wh_yiwu_01: "浙江省金华市义乌市北苑街道 xx 路 88 号（义乌仓）",
  wh_guangzhou_01: "广东省广州市白云区石井街道 xx 物流园 16 栋（广州仓）",
  wh_dongguan_01: "广东省东莞市虎门镇 xx 工业区 9 号（东莞仓）",
};

type FreightTransportMode = "land" | "sea" | "express";
type FreightCargoType = "normal" | "inspection" | "sensitive";

const freightRateMap: Record<FreightTransportMode, Record<FreightCargoType, number>> = {
  // 统一按“计费体积（立方米）× 单价（元/立方米）”计费
  // 注：海运普货 540 元/立方米（按你提供的口径）
  land: { normal: 680, inspection: 780, sensitive: 980 },
  express: { normal: 980, inspection: 1180, sensitive: 1480 },
  sea: { normal: 540, inspection: 680, sensitive: 880 },
};

export default function ClientHomePage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [queryMode, setQueryMode] = useState<"unfinished" | "completed" | null>(null);
  const [queriedOrders, setQueriedOrders] = useState<OrderItem[]>([]);
  const [hasQueried, setHasQueried] = useState(false);
  const [pendingPrealerts, setPendingPrealerts] = useState<OrderItem[]>([]);
  const [prealertsCollapsed, setPrealertsCollapsed] = useState(true);
  const [showAllPrealerts, setShowAllPrealerts] = useState(false);
  const [queryPanelCollapsed, setQueryPanelCollapsed] = useState(false);
  const [openLogisticsByOrder, setOpenLogisticsByOrder] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState(initialSearch);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [freightForm, setFreightForm] = useState({
    warehouseId: "",
    transportMode: "land" as FreightTransportMode,
    cargoType: "normal" as FreightCargoType,
    weightKg: "",
    volumeM3: "",
    unitPriceOverride: "",
  });
  const [form, setForm] = useState({
    warehouseId: "",
    itemName: "",
    packageCount: "",
    packageUnit: "box" as "bag" | "box",
    weightKg: "",
    volumeM3: "",
    domesticTrackingNo: "",
    transportMode: "" as "" | "sea" | "land",
  });

  const refreshMainData = async () => {
    const prealertData = await fetchClientPrealerts();
    setPendingPrealerts(prealertData);
  };

  useEffect(() => {
    setLoading(true);
    refreshMainData()
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

  const submitPrealert = async () => {
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
        transportMode: form.transportMode as "sea" | "land",
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
      setMessage("请先选择“订单在途”或“订单已完成”。");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const baseOrders = await fetchClientOrders({ statusGroup: queryMode });
      const result = baseOrders
        .filter((item) => !search.batchNo || (item.batchNo ?? "").toLowerCase().includes(search.batchNo.toLowerCase()))
        .filter((item) => !search.orderId || item.id.toLowerCase().includes(search.orderId.toLowerCase()))
        .filter((item) => !search.arrivedDate || item.createdAt.startsWith(search.arrivedDate))
        .filter(
          (item) =>
            !search.domesticTrackingNo ||
            (item.domesticTrackingNo ?? "").toLowerCase().includes(search.domesticTrackingNo.toLowerCase()),
        )
        .filter((item) => !search.status || (item.currentStatus ?? "").toLowerCase() === search.status.toLowerCase())
        .filter((item) => !search.transportMode || item.transportMode === search.transportMode)
        .filter((item) => !search.warehouseId || item.warehouseId === search.warehouseId);
      setQueriedOrders(result);
      setHasQueried(true);
    } catch (error) {
      const text = error instanceof Error ? error.message : "查询失败";
      setMessage(`查询失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const changeQueryMode = (mode: "unfinished" | "completed") => {
    setQueryMode(mode);
    setSearch(initialSearch);
    setHasQueried(false);
    setQueriedOrders([]);
    setMessage("");
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

  const statusToneClass = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (value === "delivered") return "order-badge order-badge-land";
    if (value === "intransit" || value === "customsth" || value === "warehouseth") {
      return "order-badge order-badge-sea";
    }
    return "order-badge";
  };

  const logisticsStatusText = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (value === "delivered" || value === "returned" || value === "cancelled") return "已到达";
    if (value === "intransit" || value === "customsth" || value === "outfordelivery") return "途中";
    return "已收货";
  };

  const freightWeight = Number(freightForm.weightKg || 0);
  const freightVolume = Number(freightForm.volumeM3 || 0);
  const safeWeight = Number.isNaN(freightWeight) ? 0 : Math.max(freightWeight, 0);
  const safeVolume = Number.isNaN(freightVolume) ? 0 : Math.max(freightVolume, 0);
  const defaultUnitPrice = freightRateMap[freightForm.transportMode][freightForm.cargoType];
  const overrideUnitPriceRaw = freightForm.unitPriceOverride.trim();
  const overrideUnitPrice = overrideUnitPriceRaw ? Number(overrideUnitPriceRaw) : undefined;
  const unitPrice =
    overrideUnitPrice !== undefined && !Number.isNaN(overrideUnitPrice) && overrideUnitPrice > 0
      ? overrideUnitPrice
      : defaultUnitPrice;
  const convertedVolumeByWeight = safeWeight / 500;
  const chargeVolume = Math.max(safeVolume, convertedVolumeByWeight);
  const estimatedFee = chargeVolume * unitPrice;
  const hasFreightInput = safeWeight > 0 || safeVolume > 0;
  const cargoTypeLabel =
    freightForm.cargoType === "normal"
      ? "普货"
      : freightForm.cargoType === "inspection"
        ? "商检货"
        : "敏感货";
  const transportLabel =
    freightForm.transportMode === "sea"
      ? "海运"
      : freightForm.transportMode === "land"
        ? "陆运"
        : "快线";

  return (
    <RoleShell allowedRole="client" title="客户端工作台">
      <p style={{ color: "#4b5563", marginBottom: 20 }}>
        客户提交预报单后会先进入“预报中”，员工审核通过后会自动进入“我的订单”。
      </p>

      <section className="client-main-section">
        <div className="section-label section-label-primary">主业务区</div>
        <h2 style={{ marginTop: 0, fontSize: 20 }}>主页</h2>

        <div style={{ marginBottom: 14, border: "1px solid #fde68a", borderRadius: 10, padding: 10, background: "#fffbeb" }}>
          <div style={{ fontWeight: 700, color: "#92400e", marginBottom: 8 }}>
            预报中订单（待员工审核）
          </div>
          <div style={{ color: "#a16207", fontSize: 13, marginBottom: 10 }}>
            当前共 {pendingPrealerts.length} 条
          </div>
          {pendingPrealerts.length > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => setPrealertsCollapsed((v) => !v)}
                style={{
                  border: "1px solid #fcd34d",
                  borderRadius: 8,
                  padding: "6px 12px",
                  background: "#fff",
                  color: "#92400e",
                }}
              >
                {prealertsCollapsed ? "展开预报中订单" : "收起预报中订单"}
              </button>
            </div>
          ) : null}
          {pendingPrealerts.length === 0 ? (
            <div style={{ color: "#a16207", fontSize: 13 }}>当前没有待审核预报单。</div>
          ) : prealertsCollapsed ? (
            <div style={{ color: "#a16207", fontSize: 13 }}>当前为折叠状态，点击“展开预报中订单”查看详情。</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {(showAllPrealerts ? pendingPrealerts : pendingPrealerts.slice(0, 1)).map((item) => (
                <article key={item.id} className="prealert-card">
                  <div className="prealert-head">
                    <div className="prealert-title">{item.id}</div>
                    <span className="prealert-badge">待审核</span>
                  </div>
                  <div className="prealert-fields">
                    <div className="prealert-field">
                      <div className="prealert-label">品名</div>
                      <div className="prealert-value">{item.itemName}</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">箱数/袋数</div>
                      <div className="prealert-value">
                        {item.packageCount} {item.packageUnit}
                      </div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">重量</div>
                      <div className="prealert-value">{item.weightKg ?? "-"} kg</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">体积</div>
                      <div className="prealert-value">{item.volumeM3 ?? "-"} m3</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">国内快递单号</div>
                      <div className="prealert-value">{item.domesticTrackingNo ?? "-"}</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">运输方式</div>
                      <div className="prealert-value">{item.transportMode === "sea" ? "海运" : "陆运"}</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">发货日期</div>
                      <div className="prealert-value">{item.shipDate ?? item.createdAt.slice(0, 10)}</div>
                    </div>
                    <div className="prealert-field">
                      <div className="prealert-label">批次号（审核后）</div>
                      <div className="prealert-value">{item.batchNo ?? "待员工填写"}</div>
                    </div>
                  </div>
                </article>
              ))}
              {pendingPrealerts.length > 1 ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAllPrealerts((v) => !v)}
                    style={{
                      border: "1px solid #fcd34d",
                      borderRadius: 8,
                      padding: "6px 12px",
                      background: "#fff",
                      color: "#92400e",
                    }}
                  >
                    {showAllPrealerts ? "收起预报单" : `展开全部（+${pendingPrealerts.length - 1}）`}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 12, background: "#f8fafc" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>AI问答</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              placeholder="例如：柜号 CAB-2026-A01 现在到哪了？"
              style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
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
              style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#1d4ed8" }}
            >
              {aiLoading ? "查询中..." : "AI 搜索"}
            </button>
          </div>
          {aiAnswer ? (
            <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "#334155", fontSize: 13 }}>{aiAnswer}</div>
          ) : null}
        </div>

        <div style={{ border: "1px solid #dbeafe", borderRadius: 10, padding: 12, marginBottom: 12, background: "#f8fbff" }}>
          <div style={{ fontWeight: 700, color: "#1e40af", marginBottom: 8 }}>运费计算器</div>
          <div style={{ color: "#475569", fontSize: 13, marginBottom: 10 }}>
            选择仓库、运输方式和货物类型后，输入重量/体积即可得到预估运费。
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            <select
              value={freightForm.warehouseId}
              onChange={(e) => setFreightForm((v) => ({ ...v, warehouseId: e.target.value }))}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="">请选择国内仓库地址</option>
              {warehouseOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={freightForm.transportMode}
              onChange={(e) =>
                setFreightForm((v) => ({ ...v, transportMode: e.target.value as FreightTransportMode }))
              }
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="land">陆运</option>
              <option value="sea">海运</option>
              <option value="express">快线</option>
            </select>
            <select
              value={freightForm.cargoType}
              onChange={(e) =>
                setFreightForm((v) => ({ ...v, cargoType: e.target.value as FreightCargoType }))
              }
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="normal">普货</option>
              <option value="inspection">商检货</option>
              <option value="sensitive">敏感货</option>
            </select>
            <input
              type="number"
              step="0.01"
              min="0"
              value={freightForm.weightKg}
              onChange={(e) => setFreightForm((v) => ({ ...v, weightKg: e.target.value }))}
              placeholder="重量（千克）"
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
            <input
              type="number"
              step="0.001"
              min="0"
              value={freightForm.volumeM3}
              onChange={(e) => setFreightForm((v) => ({ ...v, volumeM3: e.target.value }))}
              placeholder="体积（立方米）"
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
            <input
              type="number"
              step="1"
              min="0"
              value={freightForm.unitPriceOverride}
              onChange={(e) => setFreightForm((v) => ({ ...v, unitPriceOverride: e.target.value }))}
              placeholder={`体积单价（元/立方），默认 ${defaultUnitPrice}`}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
          </div>

          <div style={{ marginTop: 10, fontSize: 13, color: "#334155", whiteSpace: "pre-wrap" }}>
            {freightForm.warehouseId
              ? `仓库地址：${warehouseAddressMap[freightForm.warehouseId]}`
              : "仓库地址：请先选择仓库"}
          </div>
          <div style={{ marginTop: 8, border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", background: "#fff" }}>
            {hasFreightInput ? (
              <>
                <div style={{ fontWeight: 700, color: "#0f172a" }}>
                  预估运费：¥{estimatedFee.toFixed(2)}
                </div>
                <div style={{ marginTop: 6, color: "#334155", fontSize: 13 }}>
                  计费规则：{transportLabel} / {cargoTypeLabel}，先比较体积：
                  max(实际体积 {safeVolume.toFixed(3)}，重量折算体积 {convertedVolumeByWeight.toFixed(3)}（500千克=1立方米）)
                  = {chargeVolume.toFixed(3)} 立方米；
                  金额 = {chargeVolume.toFixed(3)} × ¥{unitPrice}/立方米 = ¥{estimatedFee.toFixed(2)}。
                </div>
                <div style={{ marginTop: 6, color: "#64748b", fontSize: 12 }}>
                  注：该结果为预估价，最终以客服复核与实际计费规则为准。
                </div>
              </>
            ) : (
              <div style={{ color: "#64748b", fontSize: 13 }}>
                请输入重量或体积后自动计算预估运费。
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="section-divider" aria-hidden />

      <section className="client-query-section">
        <div className="section-label section-label-query">查询区</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>我的订单查询</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a
              href="/client/bills"
              style={{
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                padding: "6px 10px",
                color: "#1d4ed8",
                background: "#eff6ff",
                fontWeight: 800,
                textDecoration: "none",
              }}
            >
              账单
            </a>
            <button
              type="button"
              onClick={() => setQueryPanelCollapsed((v) => !v)}
              style={{
                border: "1px solid #d1d5db",
                borderRadius: 8,
                padding: "6px 10px",
                color: "#374151",
                background: "#fff",
                fontWeight: 600,
              }}
            >
              {queryPanelCollapsed ? "展开" : "折叠"}
            </button>
          </div>
        </div>

        {!queryPanelCollapsed ? (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => changeQueryMode("unfinished")}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "6px 14px",
              color: "#fff",
              background: queryMode === "unfinished" ? "#2563eb" : "#94a3b8",
            }}
          >
            订单在途
          </button>
          <button
            type="button"
            onClick={() => changeQueryMode("completed")}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "6px 14px",
              color: "#fff",
              background: queryMode === "completed" ? "#2563eb" : "#94a3b8",
            }}
          >
            订单已完成
          </button>
            </div>

        {!queryMode ? (
          <EmptyStateCard title="订单已折叠" description="请先点击“订单在途”或“订单已完成”，再展开搜索框进行查询。" />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
              <input
                value={search.batchNo}
                onChange={(e) => setSearch((v) => ({ ...v, batchNo: e.target.value }))}
                placeholder="柜号/批次"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <input
                value={search.orderId}
                onChange={(e) => setSearch((v) => ({ ...v, orderId: e.target.value }))}
                placeholder="订单号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  type="date"
                  className="client-arrived-date-input"
                  value={search.arrivedDate}
                  onChange={(e) => setSearch((v) => ({ ...v, arrivedDate: e.target.value }))}
                  style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 64px 8px 10px", width: "100%", boxSizing: "border-box" }}
                />
                {!search.arrivedDate ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 36,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "#94a3b8",
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
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <input
                value={search.status}
                onChange={(e) => setSearch((v) => ({ ...v, status: e.target.value }))}
                placeholder="状态（如 inTransit）"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <select
                value={search.transportMode}
                onChange={(e) => setSearch((v) => ({ ...v, transportMode: e.target.value }))}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              <select
                value={search.warehouseId}
                onChange={(e) => setSearch((v) => ({ ...v, warehouseId: e.target.value }))}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
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
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}
              >
                执行查询
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearch(initialSearch);
                  setHasQueried(false);
                  setQueriedOrders([]);
                }}
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
              >
                清空条件
              </button>
            </div>

            {!hasQueried ? (
              <EmptyStateCard
                title="请选择条件后查询"
                description="当前已展开搜索框，请先设置搜索条件，再点击“执行查询”显示订单。"
              />
            ) : queriedOrders.length === 0 ? (
              <EmptyStateCard title="无匹配订单" description="可调整查询条件后重新查询。" />
            ) : null}
          </>
        )}

            {hasQueried && queriedOrders.map((item, idx) => (
          <article key={item.id} className="order-card">
            <div className="order-head">
              <div className="order-title">#{idx + 1} 订单 {item.id}</div>
              <div className="order-badges">
                <span className="order-badge order-badge-amount">金额：{formatCny(item.receivableAmountCny ?? null)}</span>
                <span
                  className={`order-badge ${(item.paymentStatus ?? "unpaid") === "paid" ? "order-badge-paid" : "order-badge-unpaid"}`}
                >
                  {(item.paymentStatus ?? "unpaid") === "paid" ? "已付款" : "待付款"}
                </span>
                <a
                  href={`/client/bills/${encodeURIComponent(item.id)}`}
                  style={{
                    border: "1px solid #bfdbfe",
                    borderRadius: 999,
                    padding: "3px 10px",
                    background: "#eff6ff",
                    color: "#1d4ed8",
                    textDecoration: "none",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  账单
                </a>
                <span className={`order-badge ${item.transportMode === "sea" ? "order-badge-sea" : "order-badge-land"}`}>
                  {item.transportMode === "sea" ? "海运" : "陆运"}
                </span>
                <span className={statusToneClass(item.currentStatus)}>{item.currentStatus ?? "-"}</span>
              </div>
            </div>

            <div className="order-fields">
              <div className="order-field">
                <div className="order-field-label">柜号/批次</div>
                <div className="order-field-value">{item.batchNo ?? "-"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">品名</div>
                <div className="order-field-value">{item.itemName}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">湘泰运单号</div>
                <div className="order-field-value">{item.trackingNo ?? "未生成"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">国内单号</div>
                <div className="order-field-value">{item.domesticTrackingNo ?? "-"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">包裹数量</div>
                <div className="order-field-value">
                  {item.packageCount} {item.packageUnit}
                </div>
              </div>
              <div className="order-field">
                <div className="order-field-label">产品数量</div>
                <div className="order-field-value">{item.productQuantity}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">重量</div>
                <div className="order-field-value">{item.weightKg ?? "-"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">体积</div>
                <div className="order-field-value">{item.volumeM3 ?? "-"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">日期（到仓日期）</div>
                <div className="order-field-value">{item.shipDate ?? item.createdAt.slice(0, 10)}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">物流状态</div>
                <div className="order-field-value">
                  {logisticsStatusText(item.currentStatus)}
                  {(item.logisticsRecords?.length ?? 0) > 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setOpenLogisticsByOrder((prev) => ({
                          ...prev,
                          [item.id]: !prev[item.id],
                        }))
                      }
                      style={{
                        marginLeft: 8,
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        padding: "2px 8px",
                        background: "#fff",
                        color: "#1d4ed8",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {openLogisticsByOrder[item.id] ? "收起记录" : `查看记录（${item.logisticsRecords?.length ?? 0}）`}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            {openLogisticsByOrder[item.id] && (item.logisticsRecords?.length ?? 0) > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  background: "#f8fafc",
                  padding: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                {item.logisticsRecords?.map((record, index) => (
                  <div
                    key={`${item.id}-${record.changedAt}-${index}`}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "#fff",
                      color: "#334155",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>
                      时间：{new Date(record.changedAt).toLocaleString("zh-CN", { hour12: false })}
                    </div>
                    <div>物流信息：{record.remark}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
            ))}
          </>
        ) : null}
      </section>

      <div className="section-divider" aria-hidden />

      <section className="client-secondary-section">
        <div className="section-label section-label-secondary">预报单区</div>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>新建预报单</h2>
        <p style={{ marginTop: 0, color: "#64748b", fontSize: 13 }}>
          批次号由员工审核时填写并回写，这里无需填写。
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 760 }}>
          <select
            value={form.warehouseId}
            onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          >
            <option value="">请选择仓库（必填）</option>
            {warehouseOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <input
            value={form.itemName}
            onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))}
            placeholder="品名"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            value={form.packageCount}
            onChange={(e) => setForm((v) => ({ ...v, packageCount: e.target.value }))}
            placeholder="箱数/袋数"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <select
            value={form.packageUnit}
            onChange={(e) => setForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          >
            <option value="box">箱</option>
            <option value="bag">袋</option>
          </select>
          <input
            type="number"
            step="0.01"
            value={form.weightKg}
            onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))}
            placeholder="重量（kg）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            step="0.001"
            value={form.volumeM3}
            onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))}
            placeholder="体积（m3）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            value={form.domesticTrackingNo}
            onChange={(e) => setForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))}
            placeholder="国内快递单号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <select
            value={form.transportMode}
            onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value as "" | "sea" | "land" }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          >
            <option value="">请选择运输方式</option>
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
          <button
            type="button"
            disabled={loading}
            onClick={() => void submitPrealert()}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}
          >
            提交预报单
          </button>
        </div>
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}

      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
