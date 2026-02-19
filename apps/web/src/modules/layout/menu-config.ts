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
  { id: "go-client", label: "客户端", href: "/client" },
  { id: "go-staff", label: "员工端", href: "/staff" },
  { id: "go-admin", label: "管理员端", href: "/admin" },
];
