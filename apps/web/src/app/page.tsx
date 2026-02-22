import RoleSwitcher from "../modules/auth/RoleSwitcher";
import MockLoginPanel from "../modules/auth/MockLoginPanel";
import { globalMenus } from "../modules/layout/menu-config";

export default function RootPage() {
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
        <h1 className="biz-title" style={{ fontSize: 28, margin: 0 }}>湘泰物流系统</h1>
        <p className="biz-subtitle" style={{ margin: "8px 0 10px 0" }}>
          单应用 RBAC 入口页。请先登录或注册，再进入对应工作台。
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {globalMenus.map((item) => (
            <a key={item.id} href={item.href} style={{ color: "#2563eb", textDecoration: "none" }}>
              <span className="badge-line">{item.label}</span>
            </a>
          ))}
        </div>
        <RoleSwitcher />
      </header>
      <MockLoginPanel />
    </main>
  );
}
