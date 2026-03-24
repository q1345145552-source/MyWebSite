import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";

const COMPLETED = new Set(["delivered", "returned", "cancelled"]);

export function registerOrderRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouseId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
    };

    if (!body.warehouseId?.trim() || !body.itemName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const now = new Date().toISOString();
    const shipDateText = body.shipDate?.trim() || now.slice(0, 10);
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const orderId = `o_${Date.now()}`;
    db.prepare(`
      INSERT INTO orders (
        id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
        weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      auth.companyId,
      auth.userId,
      body.warehouseId.trim(),
      null,
      null,
      "pending",
      body.itemName,
      0,
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      weightKg,
      volumeM3,
      null,
      "CNY",
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
        weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      null,
      "CNY",
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

  app.post("/staff/orders/set-receivable", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      receivableAmountCny?: number;
      receivableCurrency?: "CNY" | "THB";
    };
    const orderId = body.orderId?.trim();
    const amount = body.receivableAmountCny === undefined ? NaN : Number(body.receivableAmountCny);
    const currency = body.receivableCurrency === "THB" ? "THB" : "CNY";

    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(res, 400, "BAD_REQUEST", "receivableAmountCny must be greater than 0");
      return;
    }

    const order = db
      .prepare("SELECT id, warehouse_id FROM orders WHERE id = ? AND company_id = ?")
      .get(orderId, auth.companyId) as { id: string; warehouse_id: string } | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      `
      UPDATE orders
      SET receivable_amount_cny = ?, receivable_currency = ?, updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(amount, currency, now, orderId, auth.companyId);

    ok(res, { orderId, receivableAmountCny: amount, receivableCurrency: currency, updatedAt: now });
  });

  app.post("/staff/orders/set-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      paymentStatus?: "paid" | "unpaid";
      proofFileName?: string;
      proofMime?: string;
      proofBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const paymentStatus = body.paymentStatus === "paid" ? "paid" : body.paymentStatus === "unpaid" ? "unpaid" : null;
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!paymentStatus) {
      fail(res, 400, "BAD_REQUEST", "paymentStatus must be 'paid' or 'unpaid'");
      return;
    }

    const order = db
      .prepare("SELECT id, warehouse_id FROM orders WHERE id = ? AND company_id = ?")
      .get(orderId, auth.companyId) as { id: string; warehouse_id: string } | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    if (paymentStatus === "paid") {
      const proofFileName = typeof body.proofFileName === "string" ? body.proofFileName.trim() : "";
      const proofMime = typeof body.proofMime === "string" ? body.proofMime.trim() : "";
      const proofBase64 = typeof body.proofBase64 === "string" ? body.proofBase64.trim() : "";
      if (!proofFileName || !proofMime || !proofBase64) {
        fail(res, 400, "BAD_REQUEST", "payment proof is required when marking as paid");
        return;
      }
      // Basic size guard to avoid storing extremely large blobs in SQLite.
      // base64 expands ~4/3, so 4MB base64 ~= 3MB binary.
      if (proofBase64.length > 4_000_000) {
        fail(res, 400, "BAD_REQUEST", "payment proof is too large (max 4MB base64)");
        return;
      }
      try {
        const buf = Buffer.from(proofBase64, "base64");
        if (buf.length === 0) {
          fail(res, 400, "BAD_REQUEST", "invalid payment proof");
          return;
        }
      } catch {
        fail(res, 400, "BAD_REQUEST", "invalid payment proof");
        return;
      }
      db.prepare(
        `
        UPDATE orders
        SET payment_status = 'paid',
            paid_at = ?,
            paid_by = ?,
            payment_proof_file_name = ?,
            payment_proof_mime = ?,
            payment_proof_base64 = ?,
            payment_proof_uploaded_at = ?,
            updated_at = ?
        WHERE id = ? AND company_id = ?
        `,
      ).run(now, auth.userId, proofFileName, proofMime, proofBase64, now, now, orderId, auth.companyId);
      ok(res, { orderId, paymentStatus: "paid", paidAt: now, paidBy: auth.userId, updatedAt: now });
      return;
    }

    db.prepare(
      `
      UPDATE orders
      SET payment_status = 'unpaid',
          paid_at = NULL,
          paid_by = NULL,
          payment_proof_file_name = NULL,
          payment_proof_mime = NULL,
          payment_proof_base64 = NULL,
          payment_proof_uploaded_at = NULL,
          updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(now, orderId, auth.companyId);
    ok(res, { orderId, paymentStatus: "unpaid", paidAt: null, paidBy: null, updatedAt: now });
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
          o.id, o.client_id, o.warehouse_id, o.order_no, o.item_name, o.transport_mode, o.domestic_tracking_no,
          o.batch_no, o.approval_status,
          o.product_quantity, o.package_count, o.package_unit, o.weight_kg, o.volume_m3,
          o.receivable_amount_cny, o.receivable_currency,
          o.payment_status, o.paid_at, o.paid_by,
          o.ship_date, o.created_at, o.updated_at,
          s.tracking_no, s.current_status,
          (
            SELECT sl.remark
            FROM status_logs sl
            JOIN shipments sx ON sx.id = sl.shipment_id
            WHERE sx.order_id = o.id AND sl.company_id = o.company_id AND sl.remark IS NOT NULL AND sl.remark != ''
            ORDER BY sl.changed_at DESC
            LIMIT 1
          ) as latest_remark
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.company_id = ? AND o.approval_status = 'approved'
        ORDER BY o.created_at ASC
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
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      tracking_no: string | null;
      current_status: string | null;
      latest_remark: string | null;
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
      });

    const historyStmt = db.prepare(`
      SELECT sl.remark, sl.changed_at, sl.from_status, sl.to_status
      FROM status_logs sl
      JOIN shipments s ON s.id = sl.shipment_id
      WHERE s.order_id = ? AND sl.company_id = ? AND sl.remark IS NOT NULL AND sl.remark != ''
      ORDER BY sl.changed_at DESC
      LIMIT 20
    `);

    const items = filtered.map((row) => {
      const logisticsRecords = historyStmt.all(row.id, auth.companyId) as Array<{
        remark: string;
        changed_at: string;
        from_status: string;
        to_status: string;
      }>;
      return {
        id: row.id,
        warehouseId: row.warehouse_id,
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
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
        shipDate: row.ship_date,
        latestRemark: logisticsRecords[0]?.remark ?? row.latest_remark,
        logisticsRecords: logisticsRecords.map((record) => ({
          remark: record.remark,
          changedAt: record.changed_at,
          fromStatus: record.from_status,
          toStatus: record.to_status,
        })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    ok(res, {
      items,
      page: 1,
      pageSize: items.length,
      total: items.length,
    });
  });

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = db
      .prepare(`
        SELECT
          id, client_id, warehouse_id, order_no, item_name, transport_mode, domestic_tracking_no, batch_no, approval_status,
          product_quantity, package_count, package_unit, weight_kg, volume_m3, receivable_amount_cny, receivable_currency,
          payment_status, paid_at, paid_by,
          ship_date, created_at, updated_at
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
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      ship_date: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const items = rows
      .filter((row) => row.client_id === auth.userId)
      .map((row) => ({
        id: row.id,
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
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
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
          o.id, o.client_id, u.name as client_name, o.warehouse_id, o.order_no, o.item_name, o.transport_mode, o.domestic_tracking_no, o.batch_no, o.approval_status,
          o.product_quantity, o.package_count, o.package_unit, o.weight_kg, o.volume_m3, o.receivable_amount_cny, o.receivable_currency,
          o.payment_status, o.paid_at, o.paid_by,
          o.ship_date, o.created_at, o.updated_at
        FROM orders o
        LEFT JOIN users u ON u.id = o.client_id
        WHERE o.company_id = ? AND o.approval_status = 'pending'
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
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      ship_date: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const items = rows
      .filter((row) => auth.role === "admin" || editableWarehouses.includes(row.warehouse_id))
      .map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
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
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.post("/staff/prealerts/approve", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      batchNo?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      productQuantity?: number;
      weightKg?: number;
      volumeM3?: number;
      receivableAmountCny?: number;
      receivableCurrency?: "CNY" | "THB";
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      shipDate?: string;
    };
    if (!body.orderId || !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "orderId and batchNo are required");
      return;
    }

    const order = db
      .prepare(`
        SELECT
          id, warehouse_id, approval_status, item_name, product_quantity, package_count, package_unit,
          weight_kg, volume_m3, domestic_tracking_no, transport_mode, ship_date
        FROM orders
        WHERE id = ? AND company_id = ?
      `)
      .get(body.orderId, auth.companyId) as
      | {
          id: string;
          warehouse_id: string;
          approval_status: string;
          item_name: string;
          product_quantity: number;
          package_count: number;
          package_unit: string;
          weight_kg: number | null;
          volume_m3: number | null;
          domestic_tracking_no: string | null;
          transport_mode: string;
          ship_date: string | null;
        }
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
    const itemName = body.itemName?.trim() || order.item_name;
    const packageCount = body.packageCount === undefined ? order.package_count : Number(body.packageCount);
    const productQuantity = body.productQuantity === undefined ? order.product_quantity : Number(body.productQuantity);
    const packageUnit = body.packageUnit ?? (order.package_unit as "bag" | "box");
    const weightKg = body.weightKg === undefined ? order.weight_kg : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined ? order.volume_m3 : Number(body.volumeM3);
    const receivableAmountCny = body.receivableAmountCny === undefined ? null : Number(body.receivableAmountCny);
    const receivableCurrency = body.receivableCurrency === "THB" ? "THB" : "CNY";
    const domesticTrackingNo =
      body.domesticTrackingNo === undefined ? order.domestic_tracking_no : body.domesticTrackingNo.trim() || null;
    const transportMode = body.transportMode ?? (order.transport_mode as "sea" | "land");
    const shipDate = body.shipDate === undefined ? (order.ship_date ?? now.slice(0, 10)) : body.shipDate.trim();

    if (
      Number.isNaN(packageCount) ||
      Number.isNaN(productQuantity) ||
      (weightKg !== null && Number.isNaN(weightKg)) ||
      (volumeM3 !== null && Number.isNaN(volumeM3)) ||
      (receivableAmountCny !== null && Number.isNaN(receivableAmountCny))
    ) {
      fail(res, 400, "BAD_REQUEST", "invalid numeric fields");
      return;
    }
    if (receivableAmountCny === null || receivableAmountCny <= 0) {
      fail(res, 400, "BAD_REQUEST", "receivableAmountCny must be greater than 0");
      return;
    }
    if (packageUnit !== "bag" && packageUnit !== "box") {
      fail(res, 400, "BAD_REQUEST", "invalid packageUnit");
      return;
    }
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "invalid transportMode");
      return;
    }
    if (!shipDate) {
      fail(res, 400, "BAD_REQUEST", "shipDate is required");
      return;
    }
    const shipDateParsed = new Date(`${shipDate}T00:00:00`);
    if (Number.isNaN(shipDateParsed.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }

    db.prepare(`
      UPDATE orders
      SET
        approval_status = 'approved',
        batch_no = ?,
        item_name = ?,
        product_quantity = ?,
        package_count = ?,
        package_unit = ?,
        weight_kg = ?,
        volume_m3 = ?,
        receivable_amount_cny = ?,
        receivable_currency = ?,
        ship_date = ?,
        domestic_tracking_no = ?,
        transport_mode = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      batchNo,
      itemName,
      productQuantity,
      packageCount,
      packageUnit,
      weightKg,
      volumeM3,
      receivableAmountCny,
      receivableCurrency,
      shipDate,
      domesticTrackingNo,
      transportMode,
      now,
      order.id,
    );

    const existingShipment = db
      .prepare("SELECT id FROM shipments WHERE order_id = ? AND company_id = ? LIMIT 1")
      .get(order.id, auth.companyId) as { id: string } | undefined;
    if (!existingShipment) {
      const shipmentId = `s_${Date.now()}`;
      const generatedTrackingNo = `AUTO_${order.id}`;
      db.prepare(`
        INSERT INTO shipments (
          id, company_id, order_id, tracking_no, batch_no, current_status, current_location,
          weight_kg, volume_m3, package_count, package_unit, transport_mode, domestic_tracking_no,
          warehouse_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shipmentId,
        auth.companyId,
        order.id,
        generatedTrackingNo,
        batchNo,
        "created",
        null,
        weightKg,
        volumeM3,
        packageCount,
        packageUnit,
        transportMode,
        domesticTrackingNo,
        order.warehouse_id,
        now,
        now,
      );
    }
    ok(res, { orderId: order.id, batchNo, approvalStatus: "approved", approvedAt: now });
  });
}
