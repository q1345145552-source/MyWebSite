import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";

const COMPLETED = new Set(["delivered", "returned", "cancelled"]);

export function registerOrderRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
    };

    if (!body.itemName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const shipDateText = body.shipDate?.trim();
    if (!shipDateText) {
      fail(res, 400, "BAD_REQUEST", "shipDate is required");
      return;
    }
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }

    const now = shipDate.toISOString();
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const orderId = `o_${Date.now()}`;
    db.prepare(`
      INSERT INTO orders (
        id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
        weight_kg, volume_m3, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      auth.companyId,
      auth.userId,
      "wh_bkk_01",
      null,
      null,
      "pending",
      body.itemName,
      0,
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      weightKg,
      volumeM3,
      shipDateText,
      body.domesticTrackingNo ?? null,
      body.transportMode,
      "",
      "",
      "",
      "unfinished",
      now,
      now,
    );

    ok(res, { prealertId: orderId, createdAt: now });
  });

  app.post("/staff/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      batchNo?: string;
      trackingNo?: string;
      arrivedAt?: string;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      warehouseId?: string;
    };

    if (
      !body.clientId ||
      !body.itemName ||
      !body.transportMode ||
      !body.warehouseId ||
      !body.trackingNo?.trim() ||
      !body.arrivedAt?.trim()
    ) {
      fail(res, 400, "BAD_REQUEST", "missing required fields");
      return;
    }

    const arrivedAtDate = new Date(`${body.arrivedAt}T00:00:00`);
    if (Number.isNaN(arrivedAtDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid arrivedAt");
      return;
    }

    const now = arrivedAtDate.toISOString();
    const orderId = `o_${Date.now()}`;
    const shipmentId = `s_${Date.now()}`;
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    db.prepare(`
      INSERT INTO orders (
        id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
        weight_kg, volume_m3, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      auth.companyId,
      body.clientId,
      body.warehouseId,
      body.batchNo?.trim() || null,
      null,
      "approved",
      body.itemName,
      Number(body.productQuantity ?? 0),
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      weightKg,
      volumeM3,
      body.arrivedAt.trim(),
      body.domesticTrackingNo ?? null,
      body.transportMode,
      body.receiverNameTh ?? "",
      body.receiverPhoneTh ?? "",
      body.receiverAddressTh ?? "",
      "unfinished",
      now,
      now,
    );

    db.prepare(`
      INSERT INTO shipments (
        id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
        package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shipmentId,
      auth.companyId,
      orderId,
      body.trackingNo.trim(),
      body.batchNo?.trim() || null,
      "created",
      null,
      weightKg,
      volumeM3,
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      body.transportMode,
      body.domesticTrackingNo ?? null,
      body.warehouseId,
      now,
      now,
    );

    ok(res, { orderId, createdAt: now });
  });

  app.get("/client/orders", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const statusGroup = req.query.statusGroup?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    const orderNo = req.query.orderNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();

    const rows = db
      .prepare(`
        SELECT
          o.id, o.client_id, o.order_no, o.item_name, o.transport_mode, o.domestic_tracking_no,
          o.batch_no, o.approval_status,
          o.product_quantity, o.package_count, o.package_unit, o.weight_kg, o.volume_m3, o.ship_date, o.created_at, o.updated_at,
          s.tracking_no, s.current_status
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.company_id = ? AND o.approval_status = 'approved'
        ORDER BY o.created_at ASC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
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
      created_at: string;
      updated_at: string;
      tracking_no: string | null;
      current_status: string | null;
    }>;

    const filtered = rows
      .filter((row) => row.client_id === auth.userId)
      .filter((row) => !itemName || row.item_name.includes(itemName))
      .filter((row) => !transportMode || row.transport_mode === transportMode)
      .filter((row) => !trackingNo || row.tracking_no === trackingNo)
      .filter((row) => !orderNo || row.order_no === orderNo)
      .filter((row) => !domesticTrackingNo || row.domestic_tracking_no === domesticTrackingNo)
      .filter((row) => {
        const completed = row.current_status ? COMPLETED.has(row.current_status) : false;
        if (statusGroup === "completed") return completed;
        if (statusGroup === "unfinished") return !completed;
        return true;
      })
      .map((row) => ({
        id: row.id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        trackingNo: row.tracking_no,
        currentStatus: row.current_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    ok(res, {
      items: filtered,
      page: 1,
      pageSize: filtered.length,
      total: filtered.length,
    });
  });

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = db
      .prepare(`
        SELECT
          id, client_id, order_no, item_name, transport_mode, domestic_tracking_no, batch_no, approval_status,
          product_quantity, package_count, package_unit, weight_kg, volume_m3, ship_date, created_at, updated_at
        FROM orders
        WHERE company_id = ? AND approval_status = 'pending'
        ORDER BY created_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
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
      created_at: string;
      updated_at: string;
    }>;
    const items = rows
      .filter((row) => row.client_id === auth.userId)
      .map((row) => ({
        id: row.id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = db
      .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
      .get(auth.userId) as { warehouse_ids: string } | undefined;
    const editableWarehouses = parseJsonArray(user?.warehouse_ids);

    const rows = db
      .prepare(`
        SELECT
          id, client_id, warehouse_id, order_no, item_name, transport_mode, domestic_tracking_no, batch_no, approval_status,
          product_quantity, package_count, package_unit, weight_kg, volume_m3, ship_date, created_at, updated_at
        FROM orders
        WHERE company_id = ? AND approval_status = 'pending'
        ORDER BY created_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
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
      created_at: string;
      updated_at: string;
    }>;

    const items = rows
      .filter((row) => auth.role === "admin" || editableWarehouses.includes(row.warehouse_id))
      .map((row) => ({
        id: row.id,
        clientId: row.client_id,
        warehouseId: row.warehouse_id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.post("/staff/prealerts/approve", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { orderId?: string; batchNo?: string };
    if (!body.orderId || !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "orderId and batchNo are required");
      return;
    }

    const order = db
      .prepare("SELECT id, warehouse_id, approval_status FROM orders WHERE id = ? AND company_id = ?")
      .get(body.orderId, auth.companyId) as
      | { id: string; warehouse_id: string; approval_status: string }
      | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "prealert order not found");
      return;
    }
    if (order.approval_status !== "pending") {
      fail(res, 400, "VALIDATION_ERROR", "order is not pending");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse approve is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    const batchNo = body.batchNo.trim();
    db.prepare("UPDATE orders SET approval_status = 'approved', batch_no = ?, updated_at = ? WHERE id = ?").run(
      batchNo,
      now,
      order.id,
    );
    ok(res, { orderId: order.id, batchNo, approvalStatus: "approved", approvedAt: now });
  });
}
