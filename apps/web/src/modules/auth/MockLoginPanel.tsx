"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SESSIONS,
  getMockSession,
  setMockSession,
  type MockRole,
} from "../../auth/mock-session";

const roleRoutes: Record<MockRole, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
};

export default function MockLoginPanel() {
  const [session, setSession] = useState(() => DEFAULT_SESSIONS.client);
  const [selectedRole, setSelectedRole] = useState<MockRole>(session.role);

  const route = useMemo(() => roleRoutes[selectedRole], [selectedRole]);

  useEffect(() => {
    const current = getMockSession();
    setSession(current);
    setSelectedRole(current.role);
  }, []);

  return (
    <section
      style={{
        marginTop: 18,
        maxWidth: 680,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>模拟登录用户</h2>
      <p style={{ marginTop: 8, color: "#6b7280" }}>
        选择角色后会写入本地会话，后续前端请求会自动带上身份请求头。
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {(["client", "staff", "admin"] as MockRole[]).map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => setSelectedRole(role)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 999,
              padding: "6px 12px",
              background: selectedRole === role ? "#dbeafe" : "#fff",
              cursor: "pointer",
            }}
          >
            {role}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={() => {
            const next = setMockSession(selectedRole);
            setSession(next);
            window.location.href = route;
          }}
          style={{
            border: "none",
            borderRadius: 8,
            padding: "8px 14px",
            color: "#fff",
            background: "#2563eb",
            cursor: "pointer",
          }}
        >
          以 {selectedRole} 身份进入 {route}
        </button>
      </div>

      <pre
        style={{
          marginTop: 12,
          background: "#f8fafc",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
        }}
      >
{JSON.stringify(session, null, 2)}
      </pre>

      <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
        默认角色：{DEFAULT_SESSIONS.client.role}，companyId：{DEFAULT_SESSIONS.client.companyId}
      </div>
    </section>
  );
}
