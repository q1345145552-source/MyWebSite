import { apiBaseUrl, apiRequest } from "./core-api";

export function login(payload: { account: string; password: string; role?: "admin" | "staff" | "client" }) {
  return apiRequest<{ token: string; user: { id: string; name: string; role: "admin" | "staff" | "client"; companyId: string } }>(
    `${apiBaseUrl()}/auth/login`, { method: "POST", body: JSON.stringify(payload) }
  );
}

/**
 * 改自己的密码（三端通用）。改完令牌不会自动失效，调用方要负责清登录信息、让用户重新登录。
 */
export function changeOwnPassword(payload: { oldPassword: string; newPassword: string }) {
  return apiRequest<{ changed: boolean }>(
    `${apiBaseUrl()}/auth/change-password`, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }
  );
}

// registerClient() 已删除（2026-08-04）。
// 后端 /auth/register 是硬拒绝的，注册页也改成了开户说明页，此函数已无调用方。
// 账号只能由管理员在后台创建：/admin/users、/admin/users/client。
