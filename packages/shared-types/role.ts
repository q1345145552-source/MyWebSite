export type UserRole = "admin" | "staff" | "client";

export const USER_ROLES: UserRole[] = ["admin", "staff", "client"];
export type WarehouseScope = "global" | "warehouse_limited";