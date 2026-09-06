"use client";

/**
 * 出柜追踪组件 — 客户端"我的订单"卡片里显示该订单运单所属的柜子。
 *
 * 数据来源：GET /client/shipments/track?shipmentId=xxx 或 trackingNo=xxx
 * 拆柜提示：当 splitCount > 1 时自动显示"此订单分 N 柜运送"
 *
 * 用法：
 *   <ContainerTrackingSection shipmentId={item.id} trackingNo={item.trackingNo} />
 */

import { useEffect, useState } from "react";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../services/core-api";

type ContainerInfo = {
  containerId: string;
  containerNo: string;
  containerType: string;
  carrierName?: string | null;
  loadedVolumeM3: number;
  loadedPieceCount: number;
  containerStatus: string;
  containerStatusLabel: string;
  loadingDate: string | null;
  departureDate: string | null;
  eta: string | null;
  ata: string | null;
  customsClearedAt: string | null;
};

type TrackData = {
  shipmentId: string;
  trackingNo: string;
  totalVolumeM3: number;
  totalLoadedM3: number;
  isSplit: boolean;
  splitCount: number;
  containers: ContainerInfo[];
};

interface Props {
  /** 优先用 shipmentId 查询，没有则用 trackingNo */
  shipmentId?: string;
  trackingNo?: string;
  hideContainerNo?: boolean;
}

/* 柜子状态一律黑字，不用颜色区分（2026-08-10 用户定的：「不要颜色，就是黑色就行了」）。
   原来每个状态一个配色，全站换成藏青后有 5 个状态撞成同一个颜色，
   与其留一半有色一半没色，不如全部去掉 —— 状态本来就写着中文，看字就行。 */
const STATUS_PLAIN = { bg: "transparent", fg: "var(--ink)", border: "var(--line)" } as const;

function statusColor(_status: string): { bg: string; fg: string; border: string } {
  return STATUS_PLAIN;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function ContainerTrackingSection({ shipmentId, trackingNo, hideContainerNo }: Props) {
  const [data, setData] = useState<TrackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (shipmentId) params.set("shipmentId", shipmentId);
    else if (trackingNo) params.set("trackingNo", trackingNo);
    else {
      setLoading(false);
      setError("缺少 shipmentId/trackingNo");
      return;
    }

    fetch(`${apiBaseUrl()}/client/shipments/track?${params.toString()}`, {
      headers: { ...authHeaders() },
    })
      .then(async (resp) => {
        // 【审查问题 3】走 parseApiResponse：401 会自动跳登录页；失败统一走下面的 catch
        // ⚠️ 前提是上面的 fetch 必须是 `fetchWithSession as fetch`（本文件顶部 import）——
        //    parseApiResponse 靠它记住请求带的是哪枚令牌，裸 fetch 的 401 只报错、不跳登录（scripts/test-session-api.ts 有扫描）
        const json = await parseApiResponse<TrackData>(resp);
        if (cancelled) return;
        setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "网络错误");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shipmentId, trackingNo]);

  if (loading) {
    return (
      <div style={{ padding: 10, color: "#8B94A3", fontSize: 13 }}>
        正在查询出柜信息…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 10, color: "var(--c-red-2)", fontSize: 13 }}>
        出柜信息加载失败：{error}
      </div>
    );
  }

  if (!data || data.containers.length === 0) {
    return (
      <div
        style={{
          padding: "10px 12px",
          color: "#8B94A3",
          fontSize: 13,
          background: "var(--s-cool)",
          border: "1px dashed #E4E6EC",
          borderRadius: 8,
        }}
      >
        暂未装柜（货物还在仓库集货中）
      </div>
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--l-cool)",
        borderRadius: 10,
        background: "#EEF2FB",
        padding: 12,
      }}
    >
      {/* 标题 + 拆柜提示 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#14171D" }}>
          出柜追踪
          <span style={{ marginLeft: 8, color: "#8B94A3", fontWeight: 400, fontSize: 12 }}>
            总量 {data.totalVolumeM3.toFixed(2)} m³ · 已装 {data.totalLoadedM3.toFixed(2)} m³
          </span>
        </div>
        {data.isSplit ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              borderRadius: 999,
              background: "linear-gradient(90deg, var(--c-amber-bg), #fde68a)",
              color: "var(--c-amber-deep)",
              fontSize: 12,
              fontWeight: 700,
              border: "1px solid #fcd34d",
            }}
          >
            此订单分 {data.splitCount} 柜运送
          </span>
        ) : null}
      </div>

      {/* 柜子卡片列表 */}
      <div style={{ display: "grid", gap: 8 }}>
        {data.containers.map((c, idx) => {
          const color = statusColor(c.containerStatus);
          return (
            <div
              key={c.containerId}
              style={{
                border: `1px solid ${color.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                background: "var(--white)",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, color: "#14171D", fontSize: 14 }}>
                    柜 {idx + 1}{hideContainerNo ? "" : `：${c.containerNo}`}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 7px",
                      borderRadius: 4,
                      background: "var(--s-cool-2)",
                      color: "var(--t-strong)",
                      fontWeight: 600,
                    }}
                  >
                    {c.containerType}
                  </span>
                  {c.carrierName ? (
                    <span style={{ fontSize: 12, color: "#4B5462", fontWeight: 500 }}>
                      {c.carrierName}
                    </span>
                  ) : null}
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: color.bg,
                      color: color.fg,
                      fontWeight: 600,
                      border: `1px solid ${color.border}`,
                    }}
                  >
                    {c.containerStatusLabel}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#8B94A3", display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
                  <span>本柜 {c.loadedVolumeM3.toFixed(2)} m³ · {c.loadedPieceCount} 件</span>
                  <span>装柜 {formatDate(c.loadingDate)}</span>
                  <span>开船 {formatDate(c.departureDate)}</span>
                  <span>
                    {c.ata ? `到港 ${formatDate(c.ata)}` : `预计到港 ${formatDate(c.eta)}`}
                  </span>
                  {c.customsClearedAt ? <span>清关 {formatDate(c.customsClearedAt)}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
