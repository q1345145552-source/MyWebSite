"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_SESSIONS, getMockSession, type MockRole, type MockSession } from "../../auth/mock-session";
import RoleSwitcher from "../auth/RoleSwitcher";
import { globalMenus, roleMenus } from "./menu-config";

const roleTitles: Record<MockRole, string> = {
  admin: "管理员",
  staff: "员工",
  client: "客户端",
};

export default function RoleShell(props: {
  allowedRole: MockRole;
  title: string;
  children: ReactNode;
}) {
  const { allowedRole, title, children } = props;
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<MockSession>(DEFAULT_SESSIONS.client);

  useEffect(() => {
    const next = getMockSession();
    setSession(next);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (session.role !== allowedRole) {
      const timer = setTimeout(() => {
        const from = encodeURIComponent(window.location.pathname);
        window.location.href = `/forbidden?from=${from}`;
      }, 600);
      return () => clearTimeout(timer);
    }
    return;
  }, [allowedRole, mounted, session.role]);

  const subtitle = useMemo(
    () => `${roleTitles[session.role]} / ${session.userId} / ${session.companyId}`,
    [session.companyId, session.role, session.userId],
  );

  if (!mounted) {
    return (
      <main style={{ padding: 24 }}>
        <div className="shell-skeleton">
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-subtitle" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
        </div>
      </main>
    );
  }

  if (session.role !== allowedRole) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "#b91c1c" }}>
          当前身份为 {session.role}，无权访问该页面，正在跳转到 403 页面...
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24 }}>
      <header
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 14,
          marginBottom: 16,
          background: "#f8fafc",
        }}
      >
        <h1 className="biz-title" style={{ fontSize: 26, margin: 0 }}>{title}</h1>
        <p className="biz-subtitle" style={{ margin: "8px 0 10px 0" }}>{subtitle}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          {roleMenus[allowedRole].map((item) => (
            <a key={item.id} href={item.href} style={{ color: "#1d4ed8", textDecoration: "none" }}>
              <span className="badge-line">{item.label}</span>
            </a>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {globalMenus.map((item) => (
            <a key={item.id} href={item.href} style={{ color: "#2563eb", textDecoration: "none" }}>
              {item.label}
            </a>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <RoleSwitcher compact />
        </div>
      </header>
      {children}
    </main>
  );
}
