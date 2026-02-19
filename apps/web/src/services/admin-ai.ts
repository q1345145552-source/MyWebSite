import type { AiKnowledgeItem, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import { getMockSession } from "../auth/mock-session";

function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const session = getMockSession();
  return {
    "x-role": session.role,
    "x-user-id": session.userId,
    "x-company-id": session.companyId,
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}

export async function fetchStatusLabels(): Promise<StatusLabelConfig[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseResponse<StatusLabelConfig[]>(response);
}

export async function updateStatusLabels(items: StatusLabelConfig[]): Promise<{ updated: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ items }),
  });
  return parseResponse<{ updated: number }>(response);
}

export async function resetStatusLabels(): Promise<{ reset: boolean; total: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseResponse<{ reset: boolean; total: number }>(response);
}

export async function fetchKnowledgeList(companyId?: string): Promise<AiKnowledgeItem[]> {
  const url = companyId
    ? `${apiBaseUrl()}/admin/ai/knowledge?companyId=${encodeURIComponent(companyId)}`
    : `${apiBaseUrl()}/admin/ai/knowledge`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseResponse<AiKnowledgeItem[]>(response);
}

export async function createKnowledgeItem(payload: {
  title: string;
  content: string;
  companyId?: string;
}): Promise<AiKnowledgeItem> {
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseResponse<AiKnowledgeItem>(response);
}

export async function deleteKnowledgeItem(id: string, companyId?: string): Promise<{ deleted: boolean; id: string }> {
  const query = new URLSearchParams();
  query.set("id", id);
  if (companyId) query.set("companyId", companyId);
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge?${query.toString()}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseResponse<{ deleted: boolean; id: string }>(response);
}
