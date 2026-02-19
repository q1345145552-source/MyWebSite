import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { ok, requireRole } from "../core/http-utils";

export function registerAdminRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/admin/dashboard/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const staff = db
      .prepare("SELECT COUNT(1) as count FROM users WHERE company_id = ? AND role = 'staff'")
      .get(auth.companyId) as { count: number };
    const client = db
      .prepare("SELECT COUNT(1) as count FROM users WHERE company_id = ? AND role = 'client'")
      .get(auth.companyId) as { count: number };
    const newOrder = db
      .prepare(
        "SELECT COUNT(1) as count FROM orders WHERE company_id = ? AND date(created_at) = date('now')",
      )
      .get(auth.companyId) as { count: number };
    const inTransit = db
      .prepare("SELECT COUNT(1) as count FROM shipments WHERE company_id = ? AND current_status = 'inTransit'")
      .get(auth.companyId) as { count: number };
    const volume = db
      .prepare(
        "SELECT COALESCE(SUM(volume_m3), 0) as total FROM shipments WHERE company_id = ? AND date(updated_at) = date('now')",
      )
      .get(auth.companyId) as { total: number };

    ok(res, {
      staffAccountCount: staff.count,
      clientAccountCount: client.count,
      newOrderCountToday: newOrder.count,
      inTransitOrderCount: inTransit.count,
      receivedVolumeM3Today: Number(volume.total.toFixed(3)),
    });
  });
}
