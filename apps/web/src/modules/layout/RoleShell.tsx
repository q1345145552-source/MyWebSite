"use client";

import { useEffect, useState, type ReactNode } from "react";
import { clearAuthSession, getOptionalSession, type AuthRole, type AuthSession } from "../../auth/auth-session";
import { globalMenus, roleFunctionGroups, roleMenus } from "./menu-config";

const EXPANDED_GROUPS_KEY = "xt_sidebar_expanded_groups";

/**
 * 记住哪些功能分区是展开的。
 * localStorage 本身可能抛错（Safari 无痕模式、用户关掉网站数据），
 * 所以读写都要包起来 —— 记不住是小事，把整个工作台顶掉是大事。
 */
function readExpandedGroups(): string[] | null {
  try {
    const raw = window.localStorage.getItem(EXPANDED_GROUPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function saveExpandedGroups(groups: Set<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    /* 隐私模式 / 配额满：记不住就算了，不影响使用 */
  }
}

export default function RoleShell(props: {
  allowedRole: AuthRole | AuthRole[];
  title: string;
  children: ReactNode;
}) {
  const { allowedRole, title, children } = props;
  const allowedRoles = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [currentHash, setCurrentHash] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["运单管理", "我的运单"]));

  useEffect(() => {
    const next = getOptionalSession();
    setSession(next);
    setMounted(true);
    const path = window.location.pathname;
    const hash = window.location.hash;
    setCurrentPath(path);
    setCurrentHash(hash);

    // 侧边栏菜单是真链接，点一下整页跳转，组件重新挂载，
    // 展开状态就被重置回默认值了 —— 表现为「点完功能栏，分区自己收回去」。
    // 这里做两件事恢复：把上次的展开状态读回来，再把当前页所在的分区强制展开。
    const groups = roleFunctionGroups[allowedRoles[0]] ?? [];
    const restored = new Set<string>(readExpandedGroups() ?? ["运单管理", "我的运单"]);
    for (const g of groups) {
      const hit = g.items.some(
        (item) =>
          item.href === path + hash ||
          // 独立页面（href 里没有 #）按路径匹配即可
          (!item.href.includes("#") && item.href === path),
      );
      if (hit) restored.add(g.groupLabel);
    }
    setExpandedGroups(restored);
    // allowedRoles 已是稳定数组，用 join 避免引用变化导致重复执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedRoles.join(",")]);

  useEffect(() => {
    if (!mounted) return;
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
      setCurrentHash(window.location.hash);
    };
    window.addEventListener("hashchange", handleLocationChange);
    window.addEventListener("popstate", handleLocationChange);
    return () => {
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("popstate", handleLocationChange);
    };
  }, [mounted]);

  // 2026-08-07：登录信息原来只在页面打开时读一次。之后就算它被清掉
  // （在别的标签页退出登录、或者接口返回 401 被清），这个外壳还照常显示
  // 用户名和菜单 —— 看着像登着，点什么都失败。
  // 这里在「别的标签页动了登录信息」和「切回本页」时重新核对一次；
  // 发现没了就交给下面那个 effect 跳登录页。
  useEffect(() => {
    if (!mounted) return;
    const recheck = () => {
      const next = getOptionalSession();
      setSession((prev) => {
        if (!next) return null;
        // 没变化时返回原对象，避免每次核对都触发重渲染
        if (prev && prev.token === next.token && prev.userId === next.userId && prev.role === next.role) {
          return prev;
        }
        return next;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("storage", recheck);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("storage", recheck);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (!session) {
      // 2026-08-07：踢人之前把现场记下来。反复出现「所有接口都 200、
      // 却突然被弹回登录页」，没有日志根本查不出是哪一步把登录信息弄丢的。
      // ⚠️ 只记有没有、长度，绝不打印令牌内容。
      if (typeof window !== "undefined") {
        let rawLen = -1;
        let rawErr = "";
        try {
          rawLen = window.localStorage.getItem("auth_session_v1")?.length ?? 0;
        } catch (e) {
          rawErr = e instanceof Error ? e.message : String(e);
        }
        const info = {
          页面: window.location.pathname,
          浏览器里还有没有登录信息: rawLen > 0 ? `有（${rawLen} 字符）` : rawLen === 0 ? "没有" : "读不到",
          读取报错: rawErr || "无",
          再读一次的结果: getOptionalSession() ? "读到了（说明刚才是瞬时读不到）" : "还是读不到",
        };
        console.warn("[被踢回登录页] RoleShell 认为没登录", info);
        // 临时排查用：跳页之后 console 会清空，写一份到 sessionStorage
        try {
          const prev = JSON.parse(window.sessionStorage.getItem("__xt_kick_log") || "[]");
          prev.push(info);
          window.sessionStorage.setItem("__xt_kick_log", JSON.stringify(prev.slice(-10)));
        } catch { /* 存不进去就算了 */ }
      }
      const from = encodeURIComponent(window.location.pathname);
      window.location.href = `/login?from=${from}`;
      return;
    }
    if (!allowedRoles.includes(session.role)) {
      const from = encodeURIComponent(window.location.pathname);
      const goMap: Record<string, string> = { admin: "/admin", staff: "/staff", client: "/client" };
      window.location.href = `${goMap[session.role] || "/login"}?from=${from}`;
      return;
    }
    return;
  // allowedRoles 已提前计算为稳定数组，用 join 避免引用变化导致重复执行
  }, [allowedRoles.join(","), mounted, session]);

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

  if (!session) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "#b91c1c" }}>
          当前未登录，正在跳转到登录页...
        </p>
      </main>
    );
  }

  if (!allowedRoles.includes(session.role)) {
    return (
      <main style={{ padding: 24 }}>
        <h1 className="biz-title" style={{ fontSize: 28, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: "#b91c1c" }}>
          当前身份为 {session.role}，无权访问该页面，正在跳转到 403 页面...
        </p>
      </main>
    );
  }

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <main className="dashboard-layout">
      {/* 手机端遮罩 */}
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={closeSidebar} />

      <aside className={`dashboard-sidebar ${sidebarOpen ? "open" : ""}`}>
        <button type="button" className="sidebar-close-btn" onClick={closeSidebar}>×</button>
        <h2 className="dashboard-sidebar-title">工作台导航</h2>
        <div className="dashboard-sidebar-group">
          {roleMenus[session.role].map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`dashboard-sidebar-link ${currentPath === item.href ? "dashboard-sidebar-link-active" : ""}`}
              onClick={closeSidebar}
            >
              {item.label}
            </a>
          ))}
        </div>
        <h3 className="dashboard-sidebar-subtitle">功能分区</h3>
        {(roleFunctionGroups[allowedRoles[0]] ?? []).map((group) => {
          const isExpanded = expandedGroups.has(group.groupLabel);
          return (
            <div
              key={group.groupLabel}
              className={`dashboard-sidebar-group dashboard-sidebar-group-collapsible ${isExpanded ? "is-expanded" : ""}`}
            >
              <button
                type="button"
                className="dashboard-sidebar-group-header"
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.groupLabel)) next.delete(group.groupLabel);
                    else next.add(group.groupLabel);
                    // 存下来，跳转到别的页面后还能恢复
                    saveExpandedGroups(next);
                    return next;
                  });
                }}
              >
                {/* 箭头只有一个字符，展开靠 CSS 转 90 度，换字符会丢掉过渡动画 */}
                <span className="dashboard-sidebar-group-arrow">▸</span>
                {group.groupLabel}
              </button>
              {/* 收起时不摘节点，只把外层高度收到 0：摘掉就没法放收起动画了 */}
              <div className="dashboard-sidebar-group-body" aria-hidden={!isExpanded}>
                <div className="dashboard-sidebar-group-body-inner">
                  {group.items.map((item) => (
                    <a
                      key={item.id}
                      href={item.href}
                      className={`dashboard-sidebar-link ${currentPath + currentHash === item.href ? "dashboard-sidebar-link-active" : ""}`}
                      tabIndex={isExpanded ? undefined : -1}
                      onClick={closeSidebar}
                    >
                      {item.label}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        <h3 className="dashboard-sidebar-subtitle">全局菜单</h3>
        <div className="dashboard-sidebar-group">
          {globalMenus.map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`dashboard-sidebar-link ${currentPath === item.href ? "dashboard-sidebar-link-active" : ""}`}
              onClick={closeSidebar}
            >
              {item.label}
            </a>
          ))}
        </div>
        <div className="dashboard-sidebar-actions">
          <button
            type="button"
            className="dashboard-logout-button"
            onClick={() => {
              clearAuthSession();
              window.location.href = "/login";
            }}
          >
            退出账号
          </button>
        </div>
      </aside>
      <div className="dashboard-content">
        <div className="glass-topbar">
          <button type="button" className="mobile-hamburger" onClick={() => setSidebarOpen(true)}>
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </button>
          <span className="glass-topbar-title">{title}</span>
          <span className="glass-topbar-meta">{session.userId} · {session.role}</span>
        </div>
        {children}
      </div>
    </main>
  );
}
