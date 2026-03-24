import type { MockRole } from "../../auth/mock-session";

export interface MenuItem {
  id: string;
  label: string;
  href: string;
}

export const roleMenus: Record<MockRole, MenuItem[]> = {
  client: [
    { id: "client-home", label: "客户端工作台", href: "/client" },
    { id: "client-orders", label: "我的订单", href: "/client" },
    { id: "client-bills", label: "账单", href: "/client/bills" },
  ],
  staff: [
    { id: "staff-home", label: "员工工作台", href: "/staff" },
    { id: "staff-shipments", label: "运单处理", href: "/staff" },
  ],
  admin: [
    { id: "admin-home", label: "管理员工作台", href: "/admin" },
    { id: "admin-config", label: "配置与看板", href: "/admin" },
  ],
};

export const globalMenus: MenuItem[] = [
  { id: "home", label: "首页", href: "/" },
  { id: "go-login", label: "登录", href: "/login" },
  { id: "go-register", label: "注册", href: "/register" },
  { id: "go-client", label: "客户端", href: "/client" },
  { id: "go-staff", label: "员工端", href: "/staff" },
  { id: "go-admin", label: "管理员端", href: "/admin" },
];
