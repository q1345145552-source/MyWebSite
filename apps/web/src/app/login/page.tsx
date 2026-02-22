"use client";

import { useMemo, useState } from "react";
import { setAuthSession, type MockRole } from "../../auth/mock-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<MockRole, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
};

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<MockRole>("client");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const canSubmit = useMemo(() => account.trim().length > 0 && password.trim().length > 0, [account, password]);

  const submit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await login({
        account: account.trim(),
        password: password.trim(),
        role,
      });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = roleRouteMap[result.user.role];
    } catch (error) {
      const text = error instanceof Error ? error.message : "登录失败";
      setMessage(`登录失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f8fafc", padding: 20 }}>
      <section style={{ width: "100%", maxWidth: 420, border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff", padding: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>湘泰物流系统登录</h1>
        <p style={{ marginTop: 8, color: "#64748b", fontSize: 14 }}>请输入账号和密码登录系统。</p>

        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="账号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px" }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as MockRole)}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", background: "#fff" }}
          >
            <option value="client">客户</option>
            <option value="staff">员工</option>
            <option value="admin">管理员</option>
          </select>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit || loading}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "10px 12px",
              background: canSubmit && !loading ? "#2563eb" : "#94a3b8",
              color: "#fff",
              fontWeight: 600,
              cursor: canSubmit && !loading ? "pointer" : "not-allowed",
            }}
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </div>

        {message ? <p style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>{message}</p> : null}

        <div style={{ marginTop: 12, fontSize: 13 }}>
          还没有账号？<a href="/register" style={{ color: "#2563eb", textDecoration: "none" }}>去注册</a>
        </div>
      </section>
    </main>
  );
}
