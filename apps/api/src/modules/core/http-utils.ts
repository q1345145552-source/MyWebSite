import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { HttpRequest, HttpResponse } from "../../server";

type ErrorCode = Exclude<ApiResponse<unknown>["code"], "OK">;

export function ok<T>(res: HttpResponse, data: T): void {
  res.status(200).json({
    code: "OK",
    message: "success",
    data,
    timestamp: new Date().toISOString(),
  });
}

export function fail(res: HttpResponse, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({
    code,
    message,
    errors: [{ reason: message }],
    timestamp: new Date().toISOString(),
  });
}

export function requireAuth(req: HttpRequest, res: HttpResponse): NonNullable<HttpRequest["auth"]> | null {
  if (!req.auth) {
    fail(res, 401, "UNAUTHORIZED", "missing auth context");
    return null;
  }
  return req.auth;
}

export function requireRole(
  req: HttpRequest,
  res: HttpResponse,
  roles: Array<"admin" | "staff" | "client">,
): NonNullable<HttpRequest["auth"]> | null {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (!roles.includes(auth.role)) {
    fail(res, 403, "FORBIDDEN", "permission denied");
    return null;
  }
  return auth;
}

export function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}
