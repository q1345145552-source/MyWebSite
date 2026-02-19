export type MockRole = "admin" | "staff" | "client";

export interface MockSession {
  userId: string;
  companyId: string;
  role: MockRole;
}

const SESSION_KEY = "mock_session_v1";

export const DEFAULT_SESSIONS: Record<MockRole, MockSession> = {
  admin: { userId: "u_admin_001", companyId: "c_001", role: "admin" },
  staff: { userId: "u_staff_001", companyId: "c_001", role: "staff" },
  client: { userId: "u_client_001", companyId: "c_001", role: "client" },
};

export function getMockSession(): MockSession {
  if (typeof window === "undefined") return DEFAULT_SESSIONS.client;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return DEFAULT_SESSIONS.client;
  try {
    const parsed = JSON.parse(raw) as MockSession;
    if (!parsed?.role || !parsed.userId || !parsed.companyId) return DEFAULT_SESSIONS.client;
    return parsed;
  } catch {
    return DEFAULT_SESSIONS.client;
  }
}

export function setMockSession(role: MockRole): MockSession {
  const next = DEFAULT_SESSIONS[role];
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }
  return next;
}
