import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";

const STATUS_FLOW = [
  "created",
  "pickedUp",
  "inWarehouseCN",
  "customsPending",
  "inTransit",
  "customsTH",
  "outForDelivery",
  "delivered",
];
const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

function canTransit(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  const fromIndex = STATUS_FLOW.indexOf(fromStatus);
  const toIndex = STATUS_FLOW.indexOf(toStatus);
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex === fromIndex + 1;
}

export function registerShipmentRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/client/shipments/search", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();

    const rows = db
      .prepare(`
        SELECT
          s.id, s.order_id, s.tracking_no, s.batch_no, s.current_status, s.current_location, s.updated_at,
          s.weight_kg, s.volume_m3, s.package_count, s.package_unit, s.domestic_tracking_no,
          o.client_id, o.item_name, o.transport_mode
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        WHERE s.company_id = ?
        ORDER BY s.updated_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      order_id: string;
      tracking_no: string;
      batch_no: string | null;
      current_status: string;
      current_location: string | null;
      updated_at: string;
      weight_kg: number | null;
      volume_m3: number | null;
      package_count: number | null;
      package_unit: string | null;
      domestic_tracking_no: string | null;
      client_id: string;
      item_name: string;
      transport_mode: string;
    }>;

    const items = rows
      .filter((r) => r.client_id === auth.userId)
      .filter((r) => !trackingNo || r.tracking_no === trackingNo)
      .filter((r) => !domesticTrackingNo || r.domestic_tracking_no === domesticTrackingNo)
      .filter((r) => !itemName || r.item_name.includes(itemName))
      .filter((r) => !transportMode || r.transport_mode === transportMode)
      .map((r) => ({
        id: r.id,
        orderId: r.order_id,
        trackingNo: r.tracking_no,
        batchNo: r.batch_no,
        currentStatus: r.current_status,
        currentLocation: r.current_location,
        updatedAt: r.updated_at,
        weightKg: r.weight_kg,
        volumeM3: r.volume_m3,
        packageCount: r.package_count,
        packageUnit: r.package_unit,
        domesticTrackingNo: r.domestic_tracking_no,
      }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/shipments", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = db
      .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
      .get(auth.userId) as { warehouse_ids: string } | undefined;
    const editableWarehouses = parseJsonArray(user?.warehouse_ids);

    const rows = db
      .prepare(`
        SELECT
          s.id, s.tracking_no, s.batch_no, s.current_status, s.warehouse_id, s.updated_at,
          s.domestic_tracking_no, s.package_count, s.weight_kg, s.volume_m3,
          o.item_name, o.product_quantity, o.created_at
        FROM shipments s
        LEFT JOIN orders o ON o.id = s.order_id
        WHERE s.company_id = ?
        ORDER BY s.updated_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      tracking_no: string;
      batch_no: string | null;
      current_status: string;
      warehouse_id: string;
      updated_at: string;
      domestic_tracking_no: string | null;
      package_count: number | null;
      weight_kg: number | null;
      volume_m3: number | null;
      item_name: string | null;
      product_quantity: number | null;
      created_at: string | null;
    }>;

    const items = rows.map((r) => ({
      id: r.id,
      trackingNo: r.tracking_no,
      batchNo: r.batch_no,
      itemName: r.item_name ?? undefined,
      domesticTrackingNo: r.domestic_tracking_no ?? undefined,
      packageCount: r.package_count ?? undefined,
      productQuantity: r.product_quantity ?? undefined,
      weightKg: r.weight_kg ?? undefined,
      volumeM3: r.volume_m3 ?? undefined,
      arrivedAt: r.created_at ?? undefined,
      currentStatus: r.current_status,
      warehouseId: r.warehouse_id,
      updatedAt: r.updated_at,
      canEdit: auth.role === "admin" || editableWarehouses.includes(r.warehouse_id),
    }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.post("/staff/shipments/update-status", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      batchNo?: string;
      toStatus?: string;
      remark?: string;
      updateByBatch?: boolean;
    };
    if (!body.toStatus) {
      fail(res, 400, "BAD_REQUEST", "toStatus is required");
      return;
    }
    const updateByBatch = Boolean(body.updateByBatch || body.batchNo?.trim());
    if (!updateByBatch && !body.shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required when updateByBatch=false");
      return;
    }
    if (updateByBatch && !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "batchNo is required when updateByBatch=true");
      return;
    }

    const targetShipments = updateByBatch
      ? (db
          .prepare("SELECT id, current_status, warehouse_id FROM shipments WHERE batch_no = ? AND company_id = ?")
          .all(body.batchNo?.trim(), auth.companyId) as Array<{
          id: string;
          current_status: string;
          warehouse_id: string;
        }>)
      : (db
          .prepare("SELECT id, current_status, warehouse_id FROM shipments WHERE id = ? AND company_id = ?")
          .all(body.shipmentId, auth.companyId) as Array<{
          id: string;
          current_status: string;
          warehouse_id: string;
        }>);
    if (targetShipments.length === 0) {
      fail(res, 404, "NOT_FOUND", updateByBatch ? "batch shipments not found" : "shipment not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      const denied = targetShipments.some((shipment) => !editableWarehouses.includes(shipment.warehouse_id));
      if (denied) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const invalid = targetShipments.some((shipment) => !canTransit(shipment.current_status, body.toStatus));
    if (invalid) {
      fail(res, 400, "VALIDATION_ERROR", "invalid status transition");
      return;
    }

    const now = new Date().toISOString();
    const updateStmt = db.prepare("UPDATE shipments SET current_status = ?, updated_at = ? WHERE id = ?");
    const insertLogStmt = db.prepare(
      "INSERT INTO status_logs (id, company_id, shipment_id, operator_id, operator_role, from_status, to_status, remark, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    targetShipments.forEach((shipment, idx) => {
      updateStmt.run(body.toStatus, now, shipment.id);
      insertLogStmt.run(
        `sl_${Date.now()}_${idx}`,
        auth.companyId,
        shipment.id,
        auth.userId,
        auth.role,
        shipment.current_status,
        body.toStatus,
        body.remark ?? null,
        now,
      );
    });

    ok(res, {
      mode: updateByBatch ? "batch" : "single",
      batchNo: body.batchNo?.trim() || null,
      shipmentId: updateByBatch ? null : targetShipments[0]?.id,
      shipmentIds: targetShipments.map((s) => s.id),
      fromStatus: targetShipments[0]?.current_status ?? null,
      toStatus: body.toStatus,
      updatedCount: targetShipments.length,
      changedAt: now,
    });
  });
}
