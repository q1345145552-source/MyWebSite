import { getOptionalSession } from "../auth/mock-session";

/**
 * 解析并标准化 API 基础地址，避免线上误回退到本地 127.0.0.1/localhost。
 */
export function apiBaseUrl(): string {
  const envBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.VITE_API_BASE_URL;
  if (envBaseUrl?.trim()) return envBaseUrl.replace(/\/$/, "");

  if (typeof window !== "undefined" && window.location.hostname.endsWith("onrender.com")) {
    return "https://xtwlwz.onrender.com";
  }

  return "http://localhost:3001";
}

/**
 * 从本地会话构造鉴权请求头。
 */
export function authHeaders(): Record<string, string> {
  const session = getOptionalSession();
  if (!session || !session.token) {
    throw new Error("请先登录");
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

/**
 * 统一解析 API 响应并抛出可读错误信息。
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: { code?: string; message?: string; data?: T } | null = null;
  try {
    payload = text ? (JSON.parse(text) as { code?: string; message?: string; data?: T }) : null;
  } catch {
    if (!response.ok) throw new Error(`请求失败 ${response.status}${text ? `: ${text.slice(0, 150)}` : ""}`);
    throw new Error("invalid response");
  }
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}
