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
