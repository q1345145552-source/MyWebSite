export type AuthRole = "admin" | "staff" | "client";

export interface AuthSession {
  userId: string;
  companyId: string;
  role: AuthRole;
  token: string;
}

const SESSION_KEY = "auth_session_v1";

/**
 * 【审查问题 11】localStorage 本身可能抛错，不只是取到的值有问题：
 * Safari 无痕模式、用户在设置里关掉"网站数据"、iOS 低存储时，
 * 光是读 window.localStorage 就会抛 SecurityError。
 * 原来这些调用都裸着，一抛就冒到 React 上，整个工作台被错误页顶掉、根本进不去。
 * 这里统一包一层，读不到就当没登录，写不进就当没缓存。
 */
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：忽略，不影响主流程 */
  }
}

function safeRemoveItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

export function getOptionalSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  let raw = safeGetItem(SESSION_KEY);
  // 兼容旧 key 无缝迁移
  if (!raw) {
    const oldRaw = safeGetItem("mock_session_v1");
    if (oldRaw) {
      safeSetItem(SESSION_KEY, oldRaw);
      safeRemoveItem("mock_session_v1");
      raw = oldRaw;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.role || !parsed.userId || !parsed.companyId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setAuthSession(session: AuthSession): AuthSession {
  if (typeof window !== "undefined") {
    safeSetItem(SESSION_KEY, JSON.stringify(session));
  }
  return session;
}

export function clearAuthSession(): void {
  if (typeof window !== "undefined") {
    safeRemoveItem(SESSION_KEY);
  }
}

/**
 * 把客户端页面缓存的运单清单一并清掉（2026-08-31，排查报告第 57 条收尾）。
 *
 * client/page.tsx 会把整份运单清单（唛头、货名、快递单号、件数）按
 * `xt_orders_<账号>` 存进 localStorage 提速。RoleShell 的「退出账号」和
 * 改密码那两条路已经在清（见 RoleShell.tsx 里的同名函数），但**打开登录页
 * 强制清登录状态**那条路原来只清凭证不清它 —— 共用电脑上直接开 /login
 * 换人登录时，上一位客户的运单还留在浏览器里，按 F12 就翻得出来。
 *
 * ⚠️ 按前缀清、不只清当前账号：同一台机器登过几个账号就会留几份，都得清。
 * ⚠️ 键名前缀必须跟 client/page.tsx 里的 ORDERS_CACHE_PREFIX 保持一致。
 *    （RoleShell.tsx 原来私抄的一份 2026-08-31 已删，统一 import 这里这份。）
 */
export function clearClientOrderCaches(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith("xt_orders_")) doomed.push(key);
    }
    // 先收集再删：一边遍历一边删会让 localStorage 的下标错位，漏掉相邻的键
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* 隐私模式等读不了 localStorage 的场景：本来也没存进去过，不影响清理 */
  }
}
