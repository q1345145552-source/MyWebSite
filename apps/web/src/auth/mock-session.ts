export type MockRole = "admin" | "staff" | "client";

export interface MockSession {
  userId: string;
  companyId: string;
  role: MockRole;
  token: string;
}

const SESSION_KEY = "mock_session_v1";

export const DEFAULT_SESSIONS: Record<MockRole, MockSession> = {
  admin: { userId: "u_admin_001", companyId: "c_001", role: "admin", token: "" },
  staff: { userId: "u_staff_001", companyId: "c_001", role: "staff", token: "" },
  client: { userId: "u_client_001", companyId: "c_001", role: "client", token: "" },
};

export function getOptionalSession(): MockSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MockSession;
    if (!parsed?.role || !parsed.userId || !parsed.companyId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getMockSession(): MockSession {
  return getOptionalSession() ?? DEFAULT_SESSIONS.client;
}

export function setMockSession(role: MockRole): MockSession {
  const next = DEFAULT_SESSIONS[role];
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }
  return next;
}

export function setAuthSession(session: MockSession): MockSession {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  return session;
}

export function clearAuthSession(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(SESSION_KEY);
  }
}
