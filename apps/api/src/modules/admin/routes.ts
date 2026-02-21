import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password, "utf8").digest("hex");
}

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

  function hasUserColumn(column: string): boolean {
    const info = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    return info.some((r) => r.name === column);
  }

  app.get("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const role = typeof req.query?.role === "string" ? req.query.role : undefined;
    if (role !== "staff" && role !== "client") {
      ok(res, { items: [] });
      return;
    }

    const hasCompanyName = hasUserColumn("company_name");
    const hasEmail = hasUserColumn("email");
    const cols =
      hasCompanyName && hasEmail
        ? "id, company_id, role, name, phone, status, created_at, company_name, email"
        : "id, company_id, role, name, phone, status, created_at";
    const rows = db
      .prepare(
        `SELECT ${cols} FROM users WHERE company_id = ? AND role = ? ORDER BY created_at DESC`,
      )
      .all(auth.companyId, role) as Array<Record<string, string | null>>;

    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        companyId: r.company_id,
        role: r.role,
        name: r.name,
        phone: r.phone,
        status: r.status,
        createdAt: r.created_at,
        companyName: (r.company_name ?? undefined) as string | undefined,
        email: (r.email ?? undefined) as string | undefined,
      })),
    });
  });

  app.get("/admin/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const rows = db
      .prepare(`
        SELECT
          o.id, o.client_id, u.name as client_name, o.warehouse_id, o.order_no, o.item_name, o.transport_mode,
          o.domestic_tracking_no, o.batch_no, o.approval_status, o.product_quantity, o.package_count, o.package_unit,
          o.weight_kg, o.volume_m3, o.ship_date, o.status_group, o.created_at, o.updated_at
        FROM orders o
        LEFT JOIN users u ON u.id = o.client_id
        WHERE o.company_id = ?
        ORDER BY o.created_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
      client_name: string | null;
      warehouse_id: string;
      order_no: string | null;
      item_name: string;
      transport_mode: string;
      domestic_tracking_no: string | null;
      batch_no: string | null;
      approval_status: string;
      product_quantity: number;
      package_count: number;
      package_unit: string;
      weight_kg: number | null;
      volume_m3: number | null;
      ship_date: string | null;
      status_group: string;
      created_at: string;
      updated_at: string;
    }>;

    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
        clientName: r.client_name,
        warehouseId: r.warehouse_id,
        orderNo: r.order_no,
        itemName: r.item_name,
        transportMode: r.transport_mode,
        domesticTrackingNo: r.domestic_tracking_no,
        batchNo: r.batch_no,
        approvalStatus: r.approval_status,
        productQuantity: r.product_quantity,
        packageCount: r.package_count,
        packageUnit: r.package_unit,
        weightKg: r.weight_kg,
        volumeM3: r.volume_m3,
        shipDate: r.ship_date,
        statusGroup: r.status_group,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

  app.post("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      phone?: string;
      password?: string;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "name and phone are required");
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_staff_${Date.now()}`;
    const passwordHash = typeof body.password === "string" && body.password.trim() ? hashPassword(body.password.trim()) : null;

    const existing = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id) as { "1"?: number } | undefined;
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "user id already exists");
      return;
    }

    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO users (id, company_id, role, name, phone, status, warehouse_ids, created_at, password_hash)
         VALUES (?, ?, 'staff', ?, ?, 'active', '[]', ?, ?)`,
      ).run(id, auth.companyId, name, phone, now, passwordHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("password_hash") || msg.includes("no such column")) {
        fail(res, 500, "INTERNAL_ERROR", "数据库缺少 password_hash 字段，请重启 API 服务后再试。");
        return;
      }
      throw err;
    }

    ok(res, { id, name, phone, createdAt: now });
  });

  app.post("/admin/users/client", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      companyName?: string;
      phone?: string;
      email?: string;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "客户名字和电话号码为必填");
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_client_${Date.now()}`;
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() || null : null;
    const email = typeof body.email === "string" ? body.email.trim() || null : null;

    const existing = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id) as { "1"?: number } | undefined;
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "该客户账号已存在");
      return;
    }

    if (!hasUserColumn("company_name")) db.exec("ALTER TABLE users ADD COLUMN company_name TEXT");
    if (!hasUserColumn("email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");

    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO users (id, company_id, role, name, phone, status, warehouse_ids, created_at, password_hash, company_name, email)
         VALUES (?, ?, 'client', ?, ?, 'active', '[]', ?, ?, ?, ?)`,
      ).run(id, auth.companyId, name, phone, now, null, companyName, email);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("company_name") || msg.includes("email") || msg.includes("no such column")) {
        fail(res, 500, "INTERNAL_ERROR", "数据库缺少客户字段，请重启 API 服务后再试。");
        return;
      }
      throw err;
    }

    ok(res, { id, name, companyName, phone, email, createdAt: now });
  });

  app.delete("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const row = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(id) as
      | { id: string; company_id: string; role: string }
      | undefined;
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.company_id !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot delete user of another company");
      return;
    }
    if (row.role !== "staff") {
      fail(res, 403, "FORBIDDEN", "only staff can be deleted here");
      return;
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    ok(res, { deleted: true, id });
  });

  app.post("/admin/users/set-password", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; password?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const password = body.password?.trim();
    if (!password) {
      fail(res, 400, "BAD_REQUEST", "password is required");
      return;
    }

    const row = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(id) as
      | { id: string; company_id: string; role: string }
      | undefined;
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.company_id !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot update user of another company");
      return;
    }
    if (row.role !== "staff") {
      fail(res, 403, "FORBIDDEN", "only staff password can be set here");
      return;
    }

    const passwordHash = hashPassword(password);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
    ok(res, { updated: true, id });
  });
}
