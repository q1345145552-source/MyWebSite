import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
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
    const message = payload?.message ?? "request failed";
    throw new Error(message);
  }
  return payload.data as T;
}

export async function fetchAiSuggestions(): Promise<AiSuggestionResponse> {
  const response = await fetch(`${apiBaseUrl()}/client/ai/suggestions`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseResponse<AiSuggestionResponse>(response);
}

export async function sendAiMessage(payload: AiChatRequest): Promise<AiChatResponse> {
  const response = await fetch(`${apiBaseUrl()}/client/ai/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseResponse<AiChatResponse>(response);
}
