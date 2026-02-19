"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SESSIONS,
  getMockSession,
  setMockSession,
  type MockRole,
  type MockSession,
} from "../../auth/mock-session";

const roleRoutes: Record<MockRole, string> = {
  client: "/client",
  staff: "/staff",
  admin: "/admin",
};

export default function RoleSwitcher(props: { compact?: boolean }) {
  const [session, setSession] = useState<MockSession>(DEFAULT_SESSIONS.client);
  const compact = props.compact ?? false;

  useEffect(() => {
    setSession(getMockSession());
  }, []);

  const switchRole = (role: MockRole) => {
    const next = setMockSession(role);
    setSession(next);
    window.location.href = roleRoutes[role];
  };

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: compact ? 8 : 12,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: compact ? 12 : 13, color: "#6b7280", marginBottom: 8 }}>
        当前身份：{session.role} / {session.userId} / {session.companyId}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(["client", "staff", "admin"] as MockRole[]).map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => switchRole(role)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 999,
              padding: compact ? "5px 10px" : "6px 12px",
              background: session.role === role ? "#dbeafe" : "#fff",
              cursor: "pointer",
            }}
          >
            切换为 {role}
          </button>
        ))}
      </div>
    </div>
  );
}
