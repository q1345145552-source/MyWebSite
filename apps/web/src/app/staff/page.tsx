"use client";

import { useEffect, useState } from "react";
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
  const clientOptions = [
    { id: "u_client_001", name: "Client One（客户一）" },
  ];
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [shipments, setShipments] = useState<ShipmentItem[]>([]);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});
  const [createStepDone, setCreateStepDone] = useState(false);
  const [statusStepDone, setStatusStepDone] = useState(false);
  const [form, setForm] = useState({
    clientId: "u_client_001",
    warehouseId: "wh_bkk_01",
    batchNo: "CAB-2026-A01",
    trackingNo: "XT00010001",
    arrivedAt: new Date().toISOString().slice(0, 10),
    itemName: "耳机",
    productQuantity: 50,
    packageCount: 4,
    volumeM3: 0.2,
    weightKg: 18.5,
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
    setLoading(true);
    setMessage("");
    try {
      const result = await createStaffOrder({
        clientId: form.clientId,
        warehouseId: form.warehouseId,
        batchNo: form.batchNo,
        trackingNo: form.trackingNo.trim(),
        arrivedAt: form.arrivedAt,
        itemName: form.itemName,
        productQuantity: form.productQuantity,
        packageCount: form.packageCount,
        packageUnit: form.packageUnit,
        weightKg: form.weightKg,
        volumeM3: form.volumeM3,
        domesticTrackingNo: form.domesticOrderNo,
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
    const batchNo = (prealertBatchDrafts[orderId] ?? "").trim();
    if (!batchNo) {
      setMessage("请先填写批次号后再审核通过。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await approveStaffPrealert(orderId, batchNo);
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

  return (
    <RoleShell allowedRole="staff" title="员工工作台">
      <p style={{ color: "#4b5563", marginBottom: 16 }}>
        员工可创建订单、查看运单、并按状态流转规则更新状态。
      </p>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>客户预报单审核</h2>
        <StepGuide steps={["接收客户预报", "审核信息完整性", "审核通过后进入客户订单列表"]} />
        {prealerts.length === 0 ? (
          <EmptyStateCard title="暂无待审核预报单" description="客户提交预报单后会在这里显示，审核通过后会自动移出。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {prealerts.map((item) => (
              <div key={item.id} style={{ border: "1px solid #f1f5f9", borderRadius: 8, padding: 10, background: "#fff" }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {item.id} / 柜号 {item.batchNo ?? "待填写"} / 客户 {item.clientId ?? "-"}
                </div>
                <div
                  style={{
                    color: "#475569",
                    fontSize: 13,
                    marginBottom: 8,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                    gap: 6,
                  }}
                >
                  <div>品名：{item.itemName}</div>
                  <div>箱数/袋数：{item.packageCount} {item.packageUnit}</div>
                  <div>重量：{item.weightKg ?? "-"} kg</div>
                  <div>体积：{item.volumeM3 ?? "-"} m3</div>
                  <div>国内快递单号：{item.domesticTrackingNo ?? "-"}</div>
                  <div>运输方式：{item.transportMode === "sea" ? "海运" : "陆运"}</div>
                  <div>发货日期：{item.shipDate ?? item.createdAt.slice(0, 10)}</div>
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
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void approvePrealert(item.id)}
                  style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}
                >
                  审核通过
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>创建订单（员工）</h2>
        <StepGuide
          steps={["填写订单关键信息", "提交创建并生成运单", "客户端同步可见"]}
          completedSteps={createStepDone ? [0, 1, 2] : []}
        />
        <div style={{ display: "grid", gap: 8, maxWidth: 760 }}>
          <select
            value={form.clientId}
            onChange={(e) => setForm((v) => ({ ...v, clientId: e.target.value }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          >
            {clientOptions.map((item) => (
              <option key={item.id} value={item.id}>
                客户名字：{item.name}
              </option>
            ))}
          </select>
          <input value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} placeholder="仓库ID（warehouseId）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input
            value={form.trackingNo}
            onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))}
            placeholder="湘泰运单号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            value={form.domesticOrderNo}
            onChange={(e) => setForm((v) => ({ ...v, domesticOrderNo: e.target.value }))}
            placeholder="国内单号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            value={String(form.packageCount)}
            onChange={(e) => setForm((v) => ({ ...v, packageCount: Number(e.target.value || 0) }))}
            placeholder="包裹数量"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            value={String(form.productQuantity)}
            onChange={(e) => setForm((v) => ({ ...v, productQuantity: Number(e.target.value || 0) }))}
            placeholder="产品数量"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            step="0.001"
            value={String(form.volumeM3)}
            onChange={(e) => setForm((v) => ({ ...v, volumeM3: Number(e.target.value || 0) }))}
            placeholder="体积（m3）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="number"
            step="0.01"
            value={String(form.weightKg)}
            onChange={(e) => setForm((v) => ({ ...v, weightKg: Number(e.target.value || 0) }))}
            placeholder="重量（kg）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <input
            type="date"
            value={form.arrivedAt}
            onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))}
            placeholder="到仓日期"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}>
            创建订单
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>更新运单状态</h2>
        <StepGuide
          steps={["选择单号或批次", "选择目标状态", "提交并记录痕迹"]}
          completedSteps={statusStepDone ? [0, 1, 2] : []}
        />
        <div style={{ display: "grid", gap: 8, maxWidth: 760 }}>
          <label style={{ color: "#475569", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={statusForm.updateByBatch}
              onChange={(e) => setStatusForm((v) => ({ ...v, updateByBatch: e.target.checked }))}
            />
            按柜号/批次同步更新（同批次全部单号同步）
          </label>
          {statusForm.updateByBatch ? (
            <input value={statusForm.batchNo} onChange={(e) => setStatusForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="batchNo / 柜号（例如 CAB-2026-A01）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          ) : (
            <input value={statusForm.shipmentId} onChange={(e) => setStatusForm((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="shipmentId" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          )}
          <input value={statusForm.toStatus} onChange={(e) => setStatusForm((v) => ({ ...v, toStatus: e.target.value }))} placeholder="toStatus" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={statusForm.remark} onChange={(e) => setStatusForm((v) => ({ ...v, remark: e.target.value }))} placeholder="remark" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <button type="button" disabled={loading} onClick={() => void submitStatusUpdate()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#059669" }}>
            更新状态
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>运单列表（staff）</h2>
        <StepGuide steps={["查看仓库范围数据", "确认状态是否可编辑", "继续流转下一节点"]} />
        {shipments.length === 0 ? (
          <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
        ) : null}
        {shipments.map((item) => (
          <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{item.id} / 状态：{item.currentStatus}</div>
            <div style={{ color: "#6b7280", fontSize: 13, display: "grid", gap: 4 }}>
              <div>柜号：{item.batchNo ?? "-"}</div>
              <div>品名：{item.itemName ?? "-"}</div>
              <div>湘泰运单号：{item.trackingNo ?? "-"}</div>
              <div>国内单号：{item.domesticTrackingNo ?? "-"}</div>
              <div>包裹数量：{item.packageCount ?? "-"}</div>
              <div>产品数量：{item.productQuantity ?? "-"}</div>
              <div>重量：{item.weightKg ?? "-"} kg</div>
              <div>体积：{item.volumeM3 ?? "-"} m3</div>
              <div>到仓日期：{item.arrivedAt ? item.arrivedAt.slice(0, 10) : "-"}</div>
              <div>仓库：{item.warehouseId ?? "-"} | 可编辑：{item.canEdit ? "是" : "否"} | 更新时间：{item.updatedAt ?? "-"}</div>
            </div>
          </div>
        ))}
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
