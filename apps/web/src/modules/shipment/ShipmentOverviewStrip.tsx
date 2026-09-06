"use client";

import type { StaffShipmentOverview } from "../../services/business-api";

/** 三端共享统计口径；已到仓含预约派送及派送中，本月已签收按月统计。 */

export function ShipmentOverviewStrip({ data }: { data: StaffShipmentOverview | null }) {
  if (!data) return null;

  const items = [
    { n: data.inTransitCount, label: "在途", warn: false },
    { n: data.attentionCount, label: "延迟 / 查验", warn: true },
    { n: data.atWarehouseCount, label: "已到仓", warn: false },
    { n: data.signedThisMonthCount, label: "本月已签收", warn: false },
  ];

  return (
    <div className="ship-overview-strip">
      {items.map((k) => (
        <div key={k.label} className="ship-overview-item">
          <div
            className="ship-overview-value"
            style={{
              fontFamily: "var(--a3-mono)",
              fontSize: 19,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
              color: k.warn && k.n > 0 ? "var(--warn)" : "var(--ink)",
            }}
          >
            {k.n}
          </div>
          <div className="ship-overview-label">{k.label}</div>
        </div>
      ))}
    </div>
  );
}

export default ShipmentOverviewStrip;
