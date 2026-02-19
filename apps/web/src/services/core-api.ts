import { getMockSession } from "../auth/mock-session";

export function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

export function authHeaders(): Record<string, string> {
  const session = getMockSession();
  return {
    "x-role": session.role,
    "x-user-id": session.userId,
    "x-company-id": session.companyId,
  };
}

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}
