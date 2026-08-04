import { apiBaseUrl, apiRequest } from "./core-api";

export function login(payload: { account: string; password: string; role?: "admin" | "staff" | "client" }) {
  return apiRequest<{ token: string; user: { id: string; name: string; role: "admin" | "staff" | "client"; companyId: string } }>(
    `${apiBaseUrl()}/auth/login`, { method: "POST", body: JSON.stringify(payload) }
  );
}

// registerClient() 已删除（2026-08-04）。
// 后端 /auth/register 是硬拒绝的，注册页也改成了开户说明页，此函数已无调用方。
// 账号只能由管理员在后台创建：/admin/users、/admin/users/client。
