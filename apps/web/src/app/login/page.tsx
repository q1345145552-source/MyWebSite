"use client";

import { useEffect, useMemo, useState } from "react";
import { clearAuthSession, setAuthSession } from "../../auth/auth-session";
import { login } from "../../services/auth-api";

const roleRouteMap: Record<string, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
};

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    // 打开登录页就清掉浏览器里残留的登录状态。
    // 原来这里会显示「检测到已登录账号 → 进入工作台」的快捷入口，
    // 在共用电脑上等于让后一个人免密码用上一个人的身份（登录状态保留 7 天），
    // 所以取消该入口，并强制每次都重新输账号密码。
    clearAuthSession();
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
            还没有账号？<a href="/register">申请开通</a>
          </div>
        </div>
      </div>
    </div>
  );
}
