import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../packages/shared-types/common-response";
import { authHeaders, apiBaseUrl, parseApiResponse } from "./core-api";

export async function fetchAiSuggestions(): Promise<AiSuggestionResponse> {
  const response = await fetch(`${apiBaseUrl()}/client/ai/suggestions`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseApiResponse<AiSuggestionResponse>(response);
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
  return parseApiResponse<AiChatResponse>(response);
}
