"use client";

import { useEffect, useMemo, useState } from "react";
import { clearAuthSession, getOptionalSession, setAuthSession } from "../../auth/auth-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<string, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
};

const roleLabel: Record<string, string> = {
  admin: "管理员",
  staff: "员工",
  client: "客户",
};

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [existingSession, setExistingSession] = useState<ReturnType<typeof getOptionalSession>>(null);

  useEffect(() => {
    const session = getOptionalSession();
    // 如果是 token 过期跳转回来的，清掉旧 session，不显示进入工作台按钮
    const isExpired = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("expired");
    if (isExpired) {
      clearAuthSession();
      setExistingSession(null);
    } else {
      setExistingSession(session);
    }
  }, []);

  const canSubmit = useMemo(() => account.trim().length > 0 && password.trim().length > 0, [account, password]);

  const submit = async () => {
    if (!canSubmit || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await login({
        account: account.trim(),
        password: password.trim(),
      });
      setAuthSession({
        userId: result.user.id,
        companyId: result.user.companyId,
        role: result.user.role,
        token: result.token,
      });
      window.location.href = roleRouteMap[result.user.role] || "/";
    } catch (error) {
      const text = error instanceof Error ? error.message : "登录失败";
      setMessage(`登录失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-visual">
        <div className="auth-visual-text">
          <h2>湘泰物流</h2>
          <p>中泰跨境物流管理系统<br />预报 · 装柜 · 清关 · 派送 · 签收，全程可查</p>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-form">
          {existingSession ? (
            <>
              <h1>欢迎回来</h1>
              <p className="auth-sub">检测到你已经登录过</p>
              <div className="auth-resume">
                当前账号 <strong>{existingSession.userId}</strong>
                <br />
                身份 {roleLabel[existingSession.role] ?? existingSession.role}
              </div>
              <button
                type="button"
                className="auth-btn"
                onClick={() => { window.location.href = roleRouteMap[existingSession.role] || "/"; }}
              >
                进入工作台
              </button>
              <div className="auth-foot">
                不是本人？
                <a
                  href="/login"
                  onClick={(e) => { e.preventDefault(); clearAuthSession(); setExistingSession(null); }}
                >退出并换个账号登录</a>
              </div>
            </>
          ) : (
            <>
              <h1>登录</h1>
              <p className="auth-sub">请输入账号和密码</p>

              <div className="auth-field">
                <label htmlFor="login-account">账号</label>
                <input
                  id="login-account"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                  placeholder="请输入账号"
                  autoComplete="username"
                />
              </div>

              <div className="auth-field">
                <label htmlFor="login-password">密码</label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                />
              </div>

              <button
                type="button"
                className="auth-btn"
                onClick={() => void submit()}
                disabled={!canSubmit || loading}
              >
                {loading ? "登录中…" : "登录"}
              </button>

              {message ? <p className="auth-error">{message}</p> : null}

              <div className="auth-foot">
                还没有账号？<a href="/register">去注册</a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
