export type ApiCode =
  | "OK"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export interface ApiErrorItem {
  field?: string;
  reason: string;
}

export interface ApiSuccessResponse<T> {
  code: "OK";
  message: string;
  data: T;
  requestId?: string;
  timestamp?: string;
}

export interface ApiErrorResponse {
  code: Exclude<ApiCode, "OK">;
  message: string;
  errors?: ApiErrorItem[];
  requestId?: string;
  timestamp?: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginationResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
export interface ShipmentQueryParams {
  trackingNo?: string;
  domesticTrackingNo?: string;
  itemName?: string;
  transportMode?: "sea" | "land";
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}
export interface OrderListQueryParams extends ShipmentQueryParams {
  statusGroup?: "unfinished" | "completed";
}

export interface AiChatRequest {
  message: string;
  sessionId?: string;
}

export interface AiChatResponse {
  sessionId: string;
  answer: string;
  evidence: {
    orderIds?: string[];
    shipmentIds?: string[];
    updatedAt: string;
  };
}

export interface AiSuggestionResponse {
  suggestions: string[];
}