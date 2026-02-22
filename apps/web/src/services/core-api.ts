import { getOptionalSession } from "../auth/mock-session";

export function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

export function authHeaders(): Record<string, string> {
  const session = getOptionalSession();
  if (!session || !session.token) {
    throw new Error("请先登录");
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

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
