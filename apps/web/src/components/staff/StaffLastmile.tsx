"use client";

import { useRef, useState } from "react";
import { apiBaseUrl, authHeaders, parseApiResponse } from "../../services/core-api";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";

type LmShipment = { id: string; trackingNo: string; clientId: string; itemName: string; packageCount: number; containerNo?: string };
type LmOrderItem = { id: string; deliveryNo: string; shipmentId: string; trackingNo?: string; driverName?: string; licensePlate?: string; phoneNumber?: string; deliveryDate?: string; clientId?: string; status: string; hasSignImage?: boolean };

export type StaffLastmileProps = {
  visible: boolean;
  lmShipments: LmShipment[];
  lmOrderList: LmOrderItem[];
  onToast: (msg: string) => void;
  onReloadOrders: () => void;
  onLoadShipments: () => void;
};

export default function StaffLastmile(props: StaffLastmileProps) {
  const [lmSelected, setLmSelected] = useState<Set<string>>(new Set());
  const [lmShipSearch, setLmShipSearch] = useState("");
  const [lmBatchInput, setLmBatchInput] = useState("");
  /** 粘贴批量勾选时没匹配上的运单号，必须显示出来，不能静默丢弃 */
  const [lmBatchMissing, setLmBatchMissing] = useState<string[]>([]);
  const [lmDriverName, setLmDriverName] = useState("");
  const [lmLicensePlate, setLmLicensePlate] = useState("");
  const [lmPhoneNumber, setLmPhoneNumber] = useState("");
  const [lmDeliveryDate, setLmDeliveryDate] = useState("");
  const [lmSignData, setLmSignData] = useState<{ id: string; action: string } | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [lmOrderSearch, setLmOrderSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const lmSignFileRef = useRef<HTMLInputElement>(null);

  if (!props.visible) return null;

  const createLastmile = async () => {
    const ids = Array.from(lmSelected);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(apiBaseUrl() + "/admin/lastmile/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ shipmentIds: ids, driverName: lmDriverName.trim(), licensePlate: lmLicensePlate.trim(), phoneNumber: lmPhoneNumber.trim(), deliveryDate: lmDeliveryDate }),
      });
      // 【审查问题 3】走 parseApiResponse：401 会自动跳登录页
      const d = await parseApiResponse<{ deliveryNo: string; count: number }>(r);
      props.onToast(`派送单 ${d.deliveryNo} 已创建（${d.count}个运单）`);
      setLmSelected(new Set());
      setLmDriverName("");
      setLmLicensePlate("");
      setLmPhoneNumber("");
      setLmDeliveryDate("");
      props.onReloadOrders();
    } catch (e: any) {
      props.onToast(e.message || "创建失败");
    } finally {
      setBusy(false);
    }
  };

  /**
   * 点开签收凭证时才取那一张图（2026-08-22）。
   * 原来列表接口把 570 条派送单的签收图 base64 全带回来（实测每次 113 MB），
   * 页面卡、后端每 6 天被内存撑爆，而图只显示成 40×40 缩略图。
   */
  const openSignImage = async (id: string) => {
    try {
      const res = await fetch(apiBaseUrl() + "/admin/lastmile/sign-image?id=" + encodeURIComponent(id), {
        headers: { ...authHeaders() },
      });
      const data = await parseApiResponse(res);
      const b64 = (data as any)?.signImageBase64;
      if (b64) setPreviewImg("data:image/jpeg;base64," + b64);
      else props.onToast("这条派送单没有签收凭证");
    } catch (e: any) {
      props.onToast(e?.message || "取签收凭证失败");
    }
  };

  const handleSign = (file: File) => {
    if (!lmSignData) return;
    const rdr = new FileReader();
    rdr.onload = async () => {
      const b64 = (rdr.result as string).split(",")[1] || "";
      try {
        const res = await fetch(apiBaseUrl() + "/admin/lastmile/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id: lmSignData.id, status: lmSignData.action === "sign" ? "SIGNED" : undefined, signImageBase64: b64 }),
        });
        // 【审查问题 12】原来只看 res.ok：HTTP 200 但业务失败（code != OK）
        // 照样弹「已签收」，而且 401 也不跳登录页。签收是关键节点，不能糊过去。
        await parseApiResponse(res);
        props.onToast(lmSignData.action === "sign" ? "已签收" : "图片已上传");
        props.onReloadOrders();
      } catch (e: any) {
        props.onToast(e.message || "操作失败，请重试");
      } finally {
        setLmSignData(null);
      }
    };
    rdr.readAsDataURL(file);
  };

  const deleteOrder = async (id: string) => {
    if (!confirm("确定删除？")) return;
    try {
      // 【审查问题 2】原来完全不看返回，删失败也弹「已删除」
      const res = await fetch(apiBaseUrl() + "/admin/lastmile/orders?id=" + id, { method: "DELETE", headers: authHeaders() });
      await parseApiResponse(res);
      props.onToast("已删除");
      props.onReloadOrders();
    } catch (e: any) {
      props.onToast(e.message || "删除失败，请重试");
    }
  };

  const filteredOrders = props.lmOrderList.filter(o =>
    !lmOrderSearch || (o.deliveryNo || "").includes(lmOrderSearch) || (o.trackingNo || "").includes(lmOrderSearch) || (o.clientId || "").includes(lmOrderSearch)
  );

  /** 可挑选的运单（按搜索词过滤）。抽出来是为了在下面显示「一共多少条」 */
  const filteredLmShipments = props.lmShipments.filter(s =>
    !lmShipSearch
    || (s.trackingNo || "").includes(lmShipSearch)
    || (s.clientId || "").includes(lmShipSearch)
    || (s.itemName || "").includes(lmShipSearch)
  );

  const groups: Record<string, typeof filteredOrders> = {};
  for (const o of filteredOrders) {
    if (!groups[o.deliveryNo]) groups[o.deliveryNo] = [];
    groups[o.deliveryNo].push(o);
  }

  return (
    <section id="staff-lastmile" style={{ display: "block", border: "1px solid var(--l-soft)", borderLeft: "4px solid var(--l-strong)", borderRadius: 12, padding: 16, marginBottom: 18, background: "#F0F1F4", boxShadow: "0 1px 3px rgba(15,23,42,0.06)" }}>
      <h2 style={{ marginTop: 0, fontSize: 18, color: "var(--t-heading)", marginBottom: 12 }}>尾端派送</h2>

      <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, marginBottom: 16, background: "var(--s-cool)" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>创建派送单（一车多单，逗号分隔）</h4>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: 8, background: "var(--white)" }}>
            {/* 唛头快捷勾选。2026-08-06：原来写死 .slice(0, 10)，线上有 42 个唛头，
                多出来的 32 个直接不显示、也没有任何提示（老板就是这么发现丢货的）。
                现在全部显示，一行放不下就换行。 */}
            <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
              {[...new Set(props.lmShipments.map(s => s.clientId).filter(Boolean))].map(m => (
                <button key={m} onClick={() => { setLmShipSearch(m); const found = new Set<string>(); props.lmShipments.filter(s => s.clientId === m).forEach(s => found.add(s.id)); const n = new Set(lmSelected); found.forEach(id => n.add(id)); setLmSelected(n); }} style={{ border: "1px solid #14171D", borderRadius: 4, padding: "1px 6px", fontSize: 10, background: lmShipSearch === m ? "#14171D" : "var(--white)", color: lmShipSearch === m ? "var(--white)" : "#14171D", cursor: "pointer" }}>{m}</button>
              ))}
            </div>
            {/* 粘贴运单号批量勾选。2026-08-06：原来匹配不上的号码**静默丢弃** ——
                不勾、不报错、输入框里还留着，员工以为都加进去了，实际漏了。
                现在把没找到的原样列出来。 */}
            <input value={lmBatchInput} onChange={e => setLmBatchInput(e.target.value)} onBlur={() => {
              const nums = lmBatchInput.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean);
              if (nums.length > 0) {
                const found = new Set<string>();
                const matchedNums = new Set<string>();
                props.lmShipments.forEach(s => {
                  if (nums.includes(s.trackingNo)) { found.add(s.id); matchedNums.add(s.trackingNo); }
                });
                if (found.size > 0) { const n = new Set(lmSelected); found.forEach(id => n.add(id)); setLmSelected(n); }
                const missing = nums.filter(x => !matchedNums.has(x));
                setLmBatchMissing(missing);
                setLmBatchInput(nums.join(", "));
              } else {
                setLmBatchMissing([]);
              }
            }} placeholder="粘贴运单号批量勾选..." style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 8px", fontSize: 11, width: "100%", marginBottom: 4, color: "#14171D" }} />
            {lmBatchMissing.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--c-red-deep)", marginBottom: 4, lineHeight: 1.5 }}>
                有 {lmBatchMissing.length} 个运单号没找到，<b>没有</b>加进去：{lmBatchMissing.join("、")}
                <br />
                （可能是单号打错了，或者这批货还没到仓 / 已经在别的派送单里）
              </div>
            )}
            <input value={lmShipSearch} onChange={e => setLmShipSearch(e.target.value)} onFocus={props.onLoadShipments} placeholder="搜索运单号/唛头/品名..." style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: "100%", marginBottom: 4 }} />
            {/* 2026-08-06：原来写死 .slice(0, 50)，超出的不显示也不提示。
                现在全部渲染（框本身可滚动），并在下面写清楚一共多少条。 */}
            <div style={{ maxHeight: 180, overflow: "auto" }}>
              {filteredLmShipments.map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={lmSelected.has(s.id)} onChange={() => { const n = new Set(lmSelected); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setLmSelected(n); }} />
                  <span style={{ fontFamily: "monospace", color: "var(--c-navy)", minWidth: 150 }}>{s.trackingNo}</span>
                  <span style={{ color: "#14171D", minWidth: 100, fontWeight: 600 }}>{s.clientId}</span>
                  <span style={{ color: "var(--t-body)", flex: 1 }}>{s.itemName}</span>
                  <span style={{ color: "var(--t-muted)", minWidth: 40, textAlign: "right" }}>{s.packageCount}件</span>
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--t-muted)", marginTop: 4 }}>
              已选 {lmSelected.size} 个运单 · 当前列出 {filteredLmShipments.length} 条
              {lmShipSearch ? `（共 ${props.lmShipments.length} 条，已按「${lmShipSearch}」筛选）` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={lmDriverName} onChange={e => setLmDriverName(e.target.value)} placeholder="司机姓名" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input value={lmLicensePlate} onChange={e => setLmLicensePlate(e.target.value)} placeholder="车牌号" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input value={lmPhoneNumber} onChange={e => setLmPhoneNumber(e.target.value)} placeholder="电话" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input type="date" value={lmDeliveryDate} onChange={e => setLmDeliveryDate(e.target.value)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12 }} />
          </div>
          <button disabled={busy || lmSelected.size === 0} onClick={createLastmile} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "var(--c-blue)", color: "var(--white)", cursor: "pointer", fontSize: 12, justifySelf: "start" }}>创建派送单</button>
        </div>
      </div>

      {props.lmOrderList.length === 0 ? (
        <p style={{ color: "var(--t-faint)", fontSize: 13 }}>暂无派送单</p>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <input value={lmOrderSearch} onChange={e => setLmOrderSearch(e.target.value)} placeholder="搜索派送单号/运单号/唛头..." style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: "100%" }} />
        </div>
      )}
      {Object.entries(groups).map(([dn, items]) => {
        const signed = items.filter(o => o.status === "SIGNED").length;
        const total = items.length;
        const done = signed === total;
        return (
          <div key={dn} style={{ marginBottom: 16, border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, background: done ? "#f0fdf4" : "var(--white)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <span style={{ fontFamily: "monospace", color: "var(--c-navy)" }}>{dn}</span>
                <span style={{ color: done ? "var(--c-green-3)" : "var(--t-muted)", marginLeft: 8 }}>{signed}/{total} 签收 {done ? "派送完成" : " 派送中"}</span>
              </div>
              {!done && (
                <button onClick={async () => {
                  const ids = Array.from(lmSelected);
                  if (ids.length === 0) { props.onToast("请先勾选运单"); return; }
                  try {
                    const r = await fetch(apiBaseUrl() + "/admin/lastmile/orders", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ shipmentIds: ids, deliveryNo: dn }) });
                    // 【审查问题 3】走 parseApiResponse：401 会自动跳登录页
                    const d = await parseApiResponse<{ count: number }>(r);
                    props.onToast("已追加 " + d.count + " 个运单");
                    setLmSelected(new Set());
                    props.onReloadOrders();
                  } catch (e: any) { props.onToast(e.message || "追加失败"); }
                }} style={{ border: "1px solid #B45309", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "#fefce8", color: "#B45309", cursor: "pointer" }}>追加运单</button>
              )}
            </div>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: "2px solid var(--l-cool)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>唛头</th><th style={{ padding: "4px 6px" }}>运单号</th><th style={{ padding: "4px 6px" }}>司机</th><th style={{ padding: "4px 6px" }}>车牌</th><th style={{ padding: "4px 6px" }}>电话</th><th style={{ padding: "4px 6px" }}>日期</th><th style={{ padding: "4px 6px" }}>状态</th><th style={{ padding: "4px 6px" }}>操作</th>
              </tr></thead>
              <tbody>
                {items.map(o => (
                  <tr key={o.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace", whiteSpace: "nowrap" }}>{o.clientId || "-"}</td>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{o.trackingNo || o.shipmentId}</td>
                    <td style={{ padding: "4px 6px" }}>{o.driverName ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.licensePlate ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.phoneNumber ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.deliveryDate || "-"}</td>
                    <td style={{ padding: "4px 6px" }}>
                      {o.status === "SIGNED" ? <span>已签收{o.hasSignImage ? <button onClick={() => openSignImage(o.id)} style={{ marginLeft:6, padding:"2px 8px", fontSize:11, border:"1px solid var(--c-blue)", color:"var(--c-blue)", background:"var(--white)", borderRadius:4, cursor:"pointer" }}>看凭证</button> : null}</span> : " 派送中"}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {o.status !== "SIGNED" && (
                        <button disabled={busy} onClick={() => { setLmSignData({ id: o.id, action: "sign" }); lmSignFileRef.current?.click(); }} style={{ border: "1px solid var(--c-green-3)", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "var(--white)", color: "var(--c-green-3)", cursor: "pointer" }}>签收</button>
                      )}
                      {/* 2026-08-06：这里原来只有状态文字，看不到轨迹，员工得跑回运单管理才能查 */}
                      <button
                        disabled={!o.trackingNo}
                        onClick={() => o.trackingNo && openShipmentTrack(o.trackingNo)}
                        style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "var(--white)", color: o.trackingNo ? "var(--c-navy)" : "var(--t-faint)", cursor: o.trackingNo ? "pointer" : "not-allowed", marginLeft: 4, whiteSpace: "nowrap" }}
                      >
                        物流轨迹
                      </button>
                      <button onClick={() => deleteOrder(o.id)} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 11, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", marginLeft: 4 }}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      <input ref={lmSignFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleSign(f); }} />

      {/* 签收图片放大预览 */}
      {previewImg && (
        <div onClick={() => setPreviewImg(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <img src={previewImg} alt="签收凭证" onClick={e => e.stopPropagation()} style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
        </div>
      )}
    </section>
  );
}
