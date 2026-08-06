"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import Toast from "../../../modules/layout/Toast";
import { openShipmentTrack } from "../../../modules/shipment/ShipmentTrackModal";
import {
  fetchLoadingManifests,
  createLoadingManifest,
  fetchLoadingManifestDetail,
  sealLoadingManifest,
  addShipmentToManifest,
  removeShipmentFromManifest,
  fetchStaffShipments,
  deleteContainer,
  updateContainerStatus,
  setManifestTransportMode,
  type LoadingManifestItem,
  type LoadingManifestDetail,
  type ShipmentItem,
} from "../../../services/business-api";

const STATUS_LABEL: Record<string, string> = {
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
  // 这两步由尾端派送推进，装柜页不能推，但筛选下拉里要能选，所以标签必须有
  // （2026-08-06 把筛选项改成从这张表生成后，漏了这两个会显示成英文代码）
  OUT_FOR_DELIVERY: "派送中",
  SIGNED: "已签收",
  // 陆运专属环节（2026-08-06）
  AT_PORT_CN: "到达凭祥口岸",
  EXPORT_CLEARED: "出口已放行",
  IN_VIETNAM: "过境越南",
  LAOS_CLEARED: "老挝边境已放行",
  BORDER_DELAY: "口岸滞留",
  CUSTOMS_INSPECT: "海关查验",
};

// 顺序必须与后端 containers/routes.ts 的 CONTAINER_STATUS_FLOW 一致
const STATUS_FLOW = ["LOADING", "SEALED", "DELAY_DEPARTED", "IN_TRANSIT", "DELAY_IN_TRANSIT", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"] as const;

/**
 * 陆运流程（2026-08-06）。陆运走陆路口岸，没有「开船」「到港」。
 * 顺序必须与后端 CONTAINER_STATUS_FLOW_LAND 一致，改一边必须改另一边。
 */
const STATUS_FLOW_LAND = ["LOADING", "SEALED", "AT_PORT_CN", "BORDER_DELAY", "EXPORT_CLEARED", "IN_VIETNAM", "LAOS_CLEARED", "CUSTOMS_INSPECT", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"] as const;

/**
 * 顶部「状态」筛选的可选项，**按运输方式分开**（2026-08-06 用户要求：
 * 「先选择是海运还是陆运，然后再去选择对应的状态，这柜是选的陆运，那么运输状态只会出现陆运的」）。
 * 比上面两条流程多了尾端的派送中/已签收 —— 那两个不是装柜页推进的，但可以拿来筛。
 */
const FILTER_STATUSES_SEA = ["LOADING", "SEALED", "DELAY_DEPARTED", "IN_TRANSIT", "DELAY_IN_TRANSIT", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH", "OUT_FOR_DELIVERY", "SIGNED"] as const;
const FILTER_STATUSES_LAND = ["LOADING", "SEALED", "AT_PORT_CN", "BORDER_DELAY", "EXPORT_CLEARED", "IN_VIETNAM", "LAOS_CLEARED", "CUSTOMS_INSPECT", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH", "OUT_FOR_DELIVERY", "SIGNED"] as const;

/** 每个状态默认的下一站，与后端 CONTAINER_NEXT_STOP 一致；员工可以改 */
const NEXT_STOP_DEFAULT: Record<string, string> = {
  SEALED: "广西凭祥出口",
  AT_PORT_CN: "排队出关口",
  EXPORT_CLEARED: "过境越南",
  IN_VIETNAM: "老挝",
  LAOS_CLEARED: "泰国边境",
  BORDER_DELAY: "排队出关口",
  CUSTOMS_INSPECT: "泰国仓库",
  CUSTOMS_CLEARED: "泰国仓库",
  IN_TRANSIT: "泰国港口",
  ARRIVED: "泰国清关",
};

/** 柜子的运输方式。null = 2026-08-05 之前建的老柜子，判不出来，等员工自己补 */
const MODE_ZH = (mode: string | null | undefined): string =>
  mode === "sea" ? "海运" : mode === "land" ? "陆运" : "未标注";

const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

const SHIPMENT_STATUS_ZH: Record<string, string> = {
  created: "已创建", pickedup: "已揽收", inwarehousecn: "国内仓已收货", receivedcn: "国内仓已收货",
  customspending: "报关中", loaded: "已装柜", delayDeparted: "延迟开船", delaydeparted: "延迟开船",
  departed: "已开船", delayInTransit: "延迟运输", delayintransit: "延迟运输",
  arrivedPort: "已到港", arrivedport: "已到港", intransit: "运输中",
  customsTH: "清关中", customsth: "清关中", customsCleared: "清关已放行", customscleared: "清关已放行",
  inWarehouseTH: "已到仓", inwarehouseth: "已到仓", outfordelivery: "派送中", delivered: "派送完成",
  exception: "异常", returned: "已退回", cancelled: "已取消",
  // 陆运专属环节（2026-08-06）。这个 map 大小写两种 key 都收，新加的照旧两种都写
  atPortCn: "到达凭祥口岸", atportcn: "到达凭祥口岸",
  exportCleared: "出口已放行", exportcleared: "出口已放行",
  inVietnam: "过境越南", invietnam: "过境越南",
  laosCleared: "老挝边境已放行", laoscleared: "老挝边境已放行",
  borderDelay: "口岸滞留", borderdelay: "口岸滞留",
  customsInspect: "海关查验", customsinspect: "海关查验",
};

const STATUS_COLOR: Record<string, string> = {
  LOADING: "#d97706",
  SEALED: "#16a34a",
  IN_TRANSIT: "#2563eb",
  ARRIVED: "#000000",
};

const inputStyle = { border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "#fff" } as const;

export default function StaffContainerLoadingPage() {
  const [query, setQuery] = useState("");
  const [searchTrackingNo, setSearchTrackingNo] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [modeFilter, setModeFilter] = useState("");
  const [list, setList] = useState<LoadingManifestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ warehouse: "wh_yiwu_01", transportMode: "sea", voyage: "", vesselName: "", containerNo: "" });
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<LoadingManifestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusRemark, setStatusRemark] = useState("");
  const [statusDate, setStatusDate] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  /** 下一站（2026-08-06）：选目标状态时自动填默认值，员工可改 */
  const [nextStop, setNextStop] = useState("");
    
  // 运单列表搜索
  const [allShipments, setAllShipments] = useState<ShipmentItem[]>([]);
  const [shipSearch, setShipSearch] = useState({ trackingNo: "", clientId: "", transportMode: "" });
  const [selectedShipments, setSelectedShipments] = useState<Record<string, number>>({});
  const [bulkPieceDialog, setBulkPieceDialog] = useState<string | null>(null);
  const [bulkPieceCount, setBulkPieceCount] = useState("");
  const [unloadDialog, setUnloadDialog] = useState<{itemId: string; loadedPieces: number} | null>(null);
  const [unloadCount, setUnloadCount] = useState("");
  // 已装柜运单映射：shipmentId → container manifestNo
  const [loadedShipments, setLoadedShipments] = useState<Record<string, string>>({});

  const loadShipmentList = async () => {
    const [shipments, manifests] = await Promise.all([
      fetchStaffShipments(),
      fetchLoadingManifests({ status: "ALL" }),
    ]);
    setAllShipments(shipments);
    const mapping: Record<string, string> = {};
    for (const m of manifests) {
      try {
        const d = await fetchLoadingManifestDetail(m.id);
        d.bills.forEach((b) => { mapping[b.shipmentId] = m.manifestNo; });
      } catch (e) { console.error(e); }
    }
    setLoadedShipments(mapping);
  };

  // 加载运单列表 + 已装柜信息
  useEffect(() => {
    loadShipmentList().catch(() => {});
  }, []);

  // 筛选运单
  const filteredShipments = useMemo(() => {
    return allShipments
      .filter((s) => {
        if (s.parentTrackingNo) return false;
        if (shipSearch.trackingNo && !(s.trackingNo ?? "").toLowerCase().includes(shipSearch.trackingNo.toLowerCase())) return false;
        if (shipSearch.clientId && !(s.clientId ?? "").toLowerCase().includes(shipSearch.clientId.toLowerCase())) return false;
        if (shipSearch.transportMode && s.transportMode !== shipSearch.transportMode) return false;
        return true;
      })
      .sort((a, b) => {
        const an = (a.trackingNo ?? "").replace(/\D/g, "");
        const bn = (b.trackingNo ?? "").replace(/\D/g, "");
        return (Number(bn) || 0) - (Number(an) || 0);
      });
  }, [allShipments, shipSearch]);

  // 已在本柜中的运单 ID 集合
  const existingShipmentIds = useMemo(() => {
    const set = new Set<string>();
    if (detail) detail.bills.forEach((b) => set.add(b.shipmentId));
    return set;
  }, [detail]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await fetchLoadingManifests({ query: query.trim(), trackingNo: searchTrackingNo.trim(), status: statusFilter, transportMode: modeFilter });
      setList(items);
      if (!selectedId && items.length > 0) setSelectedId(items[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [query, searchTrackingNo, statusFilter, modeFilter, selectedId]);

  useEffect(() => { void loadList(); }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    setStatusRemark("");
    setLoadingDetail(true);
    try {
      const d = await fetchLoadingManifestDetail(id);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "详情加载失败");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createLoadingManifest({
        warehouse: createForm.warehouse,
        transportMode: createForm.transportMode,
        containerNo: createForm.containerNo,
        carrierInfo: [createForm.voyage, createForm.vesselName].filter(Boolean).join(" / ") || undefined,
      });
      setToast(`装柜任务已创建: ${result.manifestNo}`);
      setShowCreate(false);
      setCreateForm({ warehouse: "wh_yiwu_01", transportMode: "sea", voyage: "", vesselName: "", containerNo: "" });
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handlePushStatus = async (toStatus: string) => {
    if (!selectedId || !detail) return;
    try {
      const result = await updateContainerStatus({ id: selectedId, toStatus, remark: statusRemark.trim() || undefined, date: statusDate || undefined, nextStop: nextStop.trim() || undefined });
      setStatusRemark("");
      setStatusDate("");
      setNextStop("");
      setToast(`柜子「${result.containerNo}」已推进至 ${STATUS_LABEL[toStatus] ?? toStatus}（影响 ${result.affectedShipmentCount} 个运单）`);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "状态更新失败");
    }
  };

  const handleSeal = async () => {
    if (!selectedId) return;
    try {
      await sealLoadingManifest(selectedId);
      setToast("封柜成功");
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "封柜失败");
    }
  };

  const handleDelete = async () => {
    if (!selectedId || !detail) return;
    if (!confirm(`确定删除柜子 ${detail.manifestNo}？\n\n此操作不可撤销。`)) return;
    try {
      await deleteContainer(selectedId);
      setToast("柜子已删除");
      setSelectedId("");
      setDetail(null);
      await loadList();
      await loadShipmentList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleBulkAdd = async () => {
    const entries = Object.entries(selectedShipments);
    if (!selectedId || entries.length === 0) return;
    setAdding(true);
    let success = 0;
    const errors: string[] = [];
    // 运输方式对不上的只提醒不拦（后端也不拦），线上真实存在海陆混装的柜
    const modeWarnings: string[] = [];
    for (const [trackingNo, pieceCount] of entries) {
      if (!trackingNo) { errors.push("空运单号"); continue; }
      try {
        const r = await addShipmentToManifest(selectedId, trackingNo, pieceCount > 0 ? pieceCount : undefined);
        if (r.warning) modeWarnings.push(`${trackingNo}（${r.warning}）`);
        success++;
      } catch (e: any) {
        errors.push(`${trackingNo}: ${e.message ?? "失败"}`);
      }
    }
    setToast(
      `成功添加 ${success} 个运单到装柜` +
      (errors.length > 0 ? `，失败 ${errors.length} 个：${errors.join("；")}` : "") +
      (modeWarnings.length > 0 ? `⚠️ 运输方式对不上：${modeWarnings.join("；")}（已装进去，如需调整请卸柜）` : ""),
    );
    setSelectedShipments({});
    await loadDetail(selectedId);
    await loadShipmentList();
    setAdding(false);
  };

  const handleRemoveShipment = async (itemId: string, pieceCount?: number) => {
    if (!selectedId) return;
    try {
      await removeShipmentFromManifest(selectedId, itemId, pieceCount);
      setToast("运单已从装柜卸下");
      await loadDetail(selectedId);
      await loadShipmentList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "卸柜失败");
    }
  };



  return (
    <RoleShell allowedRole={["staff", "admin"]} title="装柜管理">
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: "0 0 16px" }}>装柜管理</h1>

      {/* 搜索 & 新建 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索柜号…" style={{ ...inputStyle, minWidth: 150 }} />
        <input value={searchTrackingNo} onChange={(e) => setSearchTrackingNo(e.target.value)} placeholder="搜索单号…" style={{ ...inputStyle, minWidth: 150 }} />
        {/* 先选运输方式，状态下拉再跟着变 —— 海运陆运的状态不放在一起。
            「未标注」是给老柜子补运输方式用的：2026-08-05 加这个功能时，
            有 5 个海陆混装柜和 4 个空柜判不出来，留了空等员工自己点。 */}
        <select
          value={modeFilter}
          onChange={(e) => {
            setModeFilter(e.target.value);
            // 换了运输方式，原来选的状态可能压根不属于新流程，重置掉免得筛出空列表
            setStatusFilter("ALL");
          }}
          style={inputStyle}
        >
          <option value="">全部运输方式</option>
          <option value="sea">海运</option>
          <option value="land">陆运</option>
          <option value="none">未标注</option>
        </select>
        {(() => {
          // 陆运只给陆运的状态；海运和「未标注」（老柜子实际走海运）给海运的；
          // 没选运输方式时不让选状态 —— 否则又变成海陆混在一张单子里
          const modePicked = modeFilter === "sea" || modeFilter === "land" || modeFilter === "none";
          const options = modeFilter === "land" ? FILTER_STATUSES_LAND : FILTER_STATUSES_SEA;
          return (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ ...inputStyle, color: modePicked ? undefined : "#9ca3af" }}
              disabled={!modePicked}
              title={modePicked ? "" : "先选运输方式，再选对应的状态"}
            >
              <option value="ALL">{modePicked ? "全部状态" : "全部状态（先选运输方式）"}</option>
              {modePicked && options.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
              ))}
            </select>
          );
        })()}
        <button onClick={() => void loadList()} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>搜索</button>
        <button onClick={() => setShowCreate(!showCreate)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", background: "#fff", fontSize: 13, cursor: "pointer", color: "#000000" }}>
          {showCreate ? "收起" : "+ 新建装柜"}
        </button>
      </div>

      {/* 新建表单 */}
      {showCreate && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, background: "#f8fafc", marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={createForm.containerNo} onChange={(e) => setCreateForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="柜号" style={{ ...inputStyle, minWidth: 150 }} />
          {/* 必选：后端只认 sea / land，不选会 400 */}
          <select value={createForm.transportMode} onChange={(e) => setCreateForm((v) => ({ ...v, transportMode: e.target.value }))} style={inputStyle} title="这个柜子走海运还是陆运">
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
          <input value={createForm.voyage} onChange={(e) => setCreateForm((v) => ({ ...v, voyage: e.target.value }))} placeholder="船次" style={{ ...inputStyle, minWidth: 130 }} />
          <input value={createForm.vesselName} onChange={(e) => setCreateForm((v) => ({ ...v, vesselName: e.target.value }))} placeholder="船名" style={{ ...inputStyle, minWidth: 150 }} />
          <select value={createForm.warehouse} onChange={(e) => setCreateForm((v) => ({ ...v, warehouse: e.target.value }))} style={inputStyle}>
            <option value="wh_yiwu_01">义乌仓</option>
            <option value="wh_guangzhou_01">广州仓</option>
            <option value="wh_dongguan_01">东莞仓</option>
            <option value="wh_shenzhen_01">深圳仓</option>
          </select>
          <button disabled={creating} onClick={handleCreate} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: creating ? "not-allowed" : "pointer" }}>
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      )}

      {error && <p style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, alignItems: "start" }}>
        {/* 左侧柜列表
            2026-08-05：柜里最多能装 25 张运单，右边一翻，左边这列柜号就跟着滚没了，
            员工得翻回顶部才能换柜。改成贴住不动（sticky），自己太长时内部滚动。

            ⚠️ 这两个数字是量出来的，别随手改：
            滚动的不是窗口，是 RoleShell 的 .dashboard-content（globals.css:342，
            height calc(100vh - 48px) + overflow-y auto），sticky 是相对它生效的。
            它里面第一个孩子是 .glass-topbar（sticky top:12、z-index:20），实测底边在 y=56。
            所以这里必须 top:68（56 + 12 间距），写 12 的话第一个柜号会被顶栏盖住。
            maxHeight 用 calc(100vh - 92px) = 容器高(100vh-48) - top(68) - 底部留白(12) 的近似，
            实测 88 个柜号时左栏自己滚、底边不越界。 */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff", position: "sticky", top: 68, maxHeight: "calc(100vh - 92px)", overflowY: "auto" }}>
          {loading ? <p style={{ padding: 20, color: "#000000", fontSize: 13 }}>加载中…</p> : list.length === 0 ? (
            <p style={{ padding: 20, color: "#000000", fontSize: 13, textAlign: "center" }}>暂无装柜任务，请先创建装柜</p>
          ) : (
            list.map((item) => (
              <div key={item.id} onClick={() => setSelectedId(item.id)} style={{ padding: "12px 16px", cursor: "pointer", borderBottom: "1px solid #f1f5f9", background: selectedId === item.id ? "#eff6ff" : "transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>{item.manifestNo}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: STATUS_COLOR[item.status] ?? "#000000" }}>{STATUS_LABEL[item.status] ?? item.status}</span>
                </div>
                <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
                  <span style={{ color: item.transportMode ? "#1e3a8a" : "#b91c1c", fontWeight: 600 }}>{MODE_ZH(item.transportMode)}</span>
                  {" · "}{WAREHOUSE_ZH[item.warehouse] ?? item.warehouse} · {item.totalBills} 票 · {item.createdAt.slice(0, 10)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 右侧详情 + 运单列表 */}
        <div>
          {/* 柜子详情 */}
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, background: "#fff", marginBottom: 12 }}>
            {loadingDetail ? <p style={{ color: "#000000", fontSize: 13 }}>加载中…</p> : !detail ? (
              <p style={{ color: "#000000", fontSize: 13 }}>选择左侧装柜任务查看详情</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{detail.manifestNo}</h2>
                    <div style={{ fontSize: 13, color: "#000000", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>运输方式:</span>
                      {/* 未标注的老柜子在这里补；已经走到某一方专属环节时后端会拒绝，
                          界面把报错原样弹出来（2026-08-06） */}
                      <select
                        value={detail.transportMode ?? ""}
                        onChange={async (e) => {
                          const mode = e.target.value;
                          if (!mode) return;
                          try {
                            await setManifestTransportMode(detail.id, mode);
                            setToast(`柜子「${detail.manifestNo}」已标为${mode === "land" ? "陆运" : "海运"}`);
                            setTargetStatus("");
                            setNextStop("");
                            await loadDetail(detail.id);
                            await loadList();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "改运输方式失败");
                          }
                        }}
                        style={{ ...inputStyle, padding: "2px 6px", fontSize: 13, color: detail.transportMode ? "#1e3a8a" : "#b91c1c", fontWeight: 600 }}
                      >
                        {!detail.transportMode && <option value="">未标注（请选）</option>}
                        <option value="sea">海运</option>
                        <option value="land">陆运</option>
                      </select>
                      <span>
                        · 仓库: {WAREHOUSE_ZH[detail.warehouse] ?? detail.warehouse} · 状态: {STATUS_LABEL[detail.status] ?? detail.status}
                        {detail.carrierInfo ? ` · 船次/船名: ${detail.carrierInfo}` : ""}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input value={statusRemark} onChange={(e) => setStatusRemark(e.target.value)} placeholder="备注（选填）" style={{ ...inputStyle, minWidth: 200, flex: 1 }} />
                    {/* 下一站：选了目标状态就自动填上默认值，员工想改可以直接改（2026-08-06） */}
                    <input
                      value={nextStop}
                      onChange={(e) => setNextStop(e.target.value)}
                      placeholder="下一站（选填）"
                      title="客户在物流轨迹里会看到「下一站【xxx】」。选了状态会自动填，可以改"
                      style={{ ...inputStyle, maxWidth: 160 }}
                    />
                    <input type="date" value={statusDate} onChange={(e) => setStatusDate(e.target.value)} style={{ ...inputStyle, maxWidth: 150 }} title="选择日期（不选则为当天）" />
                    {(() => {
                      // 没标运输方式的柜子先别给状态选项 —— 先选海运还是陆运，
                      // 再选对应的状态，两边的状态不放在一起（2026-08-06 用户要求）
                      if (!detail.transportMode) {
                        return (
                          <span style={{ fontSize: 12, color: "#b91c1c", whiteSpace: "nowrap" }}>
                            ← 先选运输方式，才能推进状态
                          </span>
                        );
                      }
                      const flow: readonly string[] = detail.transportMode === "land" ? STATUS_FLOW_LAND : STATUS_FLOW;
                      const currentIdx = flow.indexOf(detail.status);
                      if (currentIdx < 0 || currentIdx >= flow.length - 1) return null;
                      const options = flow.slice(currentIdx + 1);
                      return (
                        <>
                          <select
                            value={targetStatus}
                            onChange={(e) => {
                              setTargetStatus(e.target.value);
                              // 换目标状态时把下一站换成该状态的默认值，员工再决定要不要改
                              setNextStop(NEXT_STOP_DEFAULT[e.target.value] ?? "");
                            }}
                            style={inputStyle}
                          >
                            <option value="">选择目标状态</option>
                            {options.map((s) => (
                              <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                            ))}
                          </select>
                          <button
                            disabled={!targetStatus}
                            onClick={() => { if (targetStatus) handlePushStatus(targetStatus); setTargetStatus(""); }}
                            style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: targetStatus ? "#2563eb" : "#94a3b8", color: "#fff", fontWeight: 500, fontSize: 13, cursor: targetStatus ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
                          >
                            确认推进
                          </button>
                        </>
                      );
                    })()}
                    {detail.status === "LOADING" && (
                      <button onClick={handleDelete} style={{ border: "1px solid #fecaca", borderRadius: 6, padding: "8px 16px", background: "#fef2f2", color: "#dc2626", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>删除柜子</button>
                    )}
                  </div>
                </div>

                {/* 已装运单列表 */}
                <div style={{ fontSize: 13, fontWeight: 500, color: "#000000", marginBottom: 8 }}>已装运单（{detail.bills.length}）</div>
                {detail.bills.length === 0 ? (
                  <p style={{ color: "#000000", fontSize: 13, marginBottom: 12 }}>暂无运单，从下方选择运单添加到本柜</p>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "4px 10px", fontSize: 11, color: "#6b7280", fontWeight: 600, borderBottom: "1px solid #e5e7eb" }}>
                      <span>运单号 / 父运单</span>
                      <span>唛头</span>
                      <span>产品/件数</span>
                      <span>运输</span>
                      <span>状态</span>
                      <span>操作</span>
                    </div>
                    {detail.bills.map((b) => (
                      <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "6px 10px", borderBottom: "1px solid #f1f5f9", alignItems: "center", background: "#fff", fontSize: 12 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontFamily: "monospace", color: "#1e3a8a" }}>{b.trackingNo ?? "—"}</span>
                          {b.parentTrackingNo ? <span style={{ display: "block", fontSize: 10, color: "#9333ea" }}>← {b.parentTrackingNo}</span> : null}
                          {b.itemName ? <span style={{ display: "block", color: "#374151", marginTop: 1 }}>{b.itemName}</span> : null}
                        </div>
                        <span style={{ color: "#6b21a8", fontWeight: 500 }}>{b.clientId ?? "—"}</span>
                        <span style={{ color: "#374151" }}>{b.loadedPieces}件{b.packageCount != null ? ` / 共${b.packageCount}件` : ""}</span>
                        <span style={{ color: "#374151" }}>{b.transportMode === "sea" ? "海运" : b.transportMode === "land" ? "陆运" : "—"}</span>
                        <span style={{ color: STATUS_COLOR[b.currentStatus ?? ""] ?? "#000000", fontWeight: 500 }}>{SHIPMENT_STATUS_ZH[b.currentStatus ?? ""] ?? b.currentStatus ?? "—"}</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          {/* 2026-08-06：这里原来只有状态文字，看不到轨迹，员工得跑回运单管理才能查 */}
                          <button
                            disabled={!b.trackingNo}
                            onClick={() => b.trackingNo && openShipmentTrack(b.trackingNo)}
                            style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: b.trackingNo ? "#1e3a8a" : "#9ca3af", cursor: b.trackingNo ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
                          >
                            物流轨迹
                          </button>
                          <button onClick={() => { setUnloadDialog({itemId: b.id, loadedPieces: b.loadedPieces}); setUnloadCount(String(b.loadedPieces)); }} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer" }}>卸柜</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 运单列表（可添加到装柜） */}
          {detail && (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, background: "#fff" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>选择运单添加到本柜</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <input value={shipSearch.trackingNo} onChange={(e) => setShipSearch((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <input value={shipSearch.clientId} onChange={(e) => setShipSearch((v) => ({ ...v, clientId: e.target.value }))} placeholder="唛头" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <select value={shipSearch.transportMode} onChange={(e) => setShipSearch((v) => ({ ...v, transportMode: e.target.value }))} style={inputStyle}>
                  <option value="">全部运输方式</option>
                  <option value="sea">海运</option>
                  <option value="land">陆运</option>
                </select>
                <button disabled={adding || Object.keys(selectedShipments).length === 0} onClick={handleBulkAdd} style={{ border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, background: Object.keys(selectedShipments).length === 0 ? "#000000" : "#2563eb", color: "#fff", cursor: Object.keys(selectedShipments).length === 0 ? "not-allowed" : "pointer", fontWeight: 600 }}>
                  {adding ? "添加中…" : `添加选中（${Object.keys(selectedShipments).length}）`}
                </button>
              </div>
              {/* 选择件数弹窗 */}
              {bulkPieceDialog && (
                <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }}>
                  <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", minWidth: 300 }} onClick={e => e.stopPropagation()}>
                    <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>装柜件数 — {bulkPieceDialog}</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="number" value={bulkPieceCount} onChange={e => setBulkPieceCount(e.target.value)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14, width: "100%" }} min="1" autoFocus />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                      <button onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 14px", background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
                      <button onClick={() => {
                        const n = parseInt(bulkPieceCount) || 0;
                        if (n > 0 && bulkPieceDialog) {
                          setSelectedShipments(p => ({ ...p, [bulkPieceDialog]: n }));
                        }
                        setBulkPieceDialog(null); setBulkPieceCount("");
                      }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13 }}>确认</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid #f1f5f9", borderRadius: 6 }}>
                {filteredShipments.length === 0 ? (
                  <p style={{ padding: 16, color: "#000000", fontSize: 13, textAlign: "center" }}>暂无匹配运单</p>
                ) : filteredShipments.map((s) => {
                    const alreadyIn = existingShipmentIds.has(s.id);
                    const loadedContainer = loadedShipments[s.id];
                    const isSelected = s.trackingNo in selectedShipments;
                    const remaining = s.packageCount ?? 0;
                    const isParent = !s.parentTrackingNo;
                    const totalPkg = s.totalPackageCount ?? remaining;
                    const children = isParent ? allShipments.filter(c => c.parentTrackingNo === s.trackingNo) : [];
                    const loadedChildren = children.filter(c => loadedShipments[c.id]);
                    return (
                      <div key={s.id} style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", opacity: alreadyIn ? 0.5 : 1, background: isSelected ? "#eff6ff" : "transparent" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input type="checkbox" checked={isSelected || alreadyIn} disabled={alreadyIn || (isParent && remaining === 0)} onChange={() => {
                            if (alreadyIn || (isParent && remaining === 0)) return;
                            if (isSelected) { const n = { ...selectedShipments }; delete n[s.trackingNo]; setSelectedShipments(n); }
                            else { setBulkPieceDialog(s.trackingNo); setBulkPieceCount(String(remaining)); }
                          }} />
                          <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace", color: "#1e3a8a", minWidth: 150 }}>{s.trackingNo}</span>
                          <span style={{ fontSize: 12, color: "#6b21a8", minWidth: 60 }}>{s.clientId ?? "—"}</span>
                          <span style={{ fontSize: 12, color: "#000000", minWidth: 140 }}>
                            {isParent ? `共${totalPkg}件` : `${totalPkg}件`}
                            {isParent && remaining < totalPkg ? <span style={{ color: "#059669", fontWeight: 600 }}>（剩{remaining}件）</span> : null}
                          </span>
                          {isSelected && <span style={{ fontSize: 11, color: "#2563eb", fontWeight: 600 }}>装{selectedShipments[s.trackingNo]}件</span>}
                          <span style={{ fontSize: 12, color: "#000000", minWidth: 50 }}>{s.transportMode === "sea" ? "海运" : s.transportMode === "land" ? "陆运" : "—"}</span>
                          <span style={{ fontSize: 12, color: alreadyIn ? "#16a34a" : loadedContainer ? "#d97706" : "#000000" }}>{alreadyIn ? "已在本柜" : loadedContainer ? `已装柜(${loadedContainer})` : SHIPMENT_STATUS_ZH[s.currentStatus ?? ""] ?? s.currentStatus ?? ""}</span>
                        </div>
                        {loadedChildren.length > 0 && (
                          <div style={{ paddingLeft: 28, fontSize: 11, color: "#6b7280", marginTop: 3 }}>
                            {loadedChildren.map(c => (
                              <span key={c.id} style={{ marginRight: 14 }}>{c.trackingNo}: {c.packageCount}件 → {loadedShipments[c.id]}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      
      {unloadDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => setUnloadDialog(null)}>
          <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", minWidth: 300 }} onClick={e => e.stopPropagation()}>
            <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>卸柜件数</h4>
            <input type="number" value={unloadCount} onChange={e => setUnloadCount(e.target.value)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14, width: "100%" }} min="1" max={unloadDialog.loadedPieces} autoFocus />
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>当前装柜 {unloadDialog.loadedPieces} 件</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setUnloadDialog(null)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 14px", background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
              <button onClick={() => { const n = parseInt(unloadCount); if (n > 0 && unloadDialog) { handleRemoveShipment(unloadDialog.itemId, n === unloadDialog.loadedPieces ? undefined : n); } setUnloadDialog(null); }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: 13 }}>确认卸柜</button>
            </div>
          </div>
        </div>
      )}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}