import { apiBaseUrl, parseApiResponse } from "./core-api";

export async function login(payload: {
  account: string;
  password: string;
  role?: "admin" | "staff" | "client";
}): Promise<{
  token: string;
  user: { id: string; name: string; role: "admin" | "staff" | "client"; companyId: string };
}> {
  const response = await fetch(`${apiBaseUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function registerClient(payload: {
  account: string;
  password: string;
  name: string;
  phone: string;
  companyId?: string;
  companyName?: string;
  email?: string;
}): Promise<{
  token: string;
  user: { id: string; name: string; role: "client"; companyId: string };
}> {
  const response = await fetch(`${apiBaseUrl()}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}
