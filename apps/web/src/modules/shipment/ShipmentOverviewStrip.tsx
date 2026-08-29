"use client";

import type { StaffShipmentOverview } from "../../services/business-api";

/* ==========================================================================
   运单列表顶部那排数字（A3 方案 §3.2）
   --------------------------------------------------------------------------
   2026-08-09 先在员工端做了一版，代码写在 staff/page.tsx 里。
   2026-08-10 用户要三端都有、而且「跟员工端一模一样」，所以抽到这里共用 ——
   三个端各抄一份的话，以后改一个必然漏另外两个（CLAUDE.md 第 20 条就是这么栽的）。

   ❌ 不做成彩色卡片，就是纯文字排一行（用户说过不要色块、不要花里胡哨）。
   只有「延迟 / 查验」有数时才变橙 —— 需要动手的那个才跳出来，其余一律黑字。

   2026-08-29 排版：外层不再写内联 style，改用 globals.css 里的
   `.ship-overview-strip`（四个数字均匀铺满整行，窄屏自动变 2×2）。
   ⚠️ 别改回内联 style —— 内联写不了 @media，窄屏那套就没了。
   ========================================================================== */

export function ShipmentOverviewStrip({ data }: { data: StaffShipmentOverview | null }) {
  if (!data) return null;

  const items = [
    { n: data.inTransitCount, label: "在途", warn: false },
    { n: data.attentionCount, label: "延迟 / 查验", warn: true },
    { n: data.atWarehouseCount, label: "已到仓待派送", warn: false },
    { n: data.signedThisMonthCount, label: "本月已签收", warn: false },
  ];

  return (
    <div className="ship-overview-strip">
      {items.map((k) => (
        <div key={k.label}>
          <div
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
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{k.label}</div>
        </div>
      ))}
    </div>
  );
}

export default ShipmentOverviewStrip;
