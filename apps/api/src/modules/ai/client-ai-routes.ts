import type {
  AiChatRequest,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { DatabaseSync } from "node:sqlite";
import type { Order, Shipment, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import {
  SqliteAiAuditStore,
  SqliteAiKnowledgeGapStore,
  SqliteAiKnowledgeStore,
  SqliteStatusLabelStore,
} from "./ai-sqlite-store";
import { SqliteAiSessionMemoryStore } from "./ai-session-memory-store";
import { ClientAiService } from "./ai-service";
import { HttpDeepSeekClient } from "./deepseek-client";
import type { AuthContext, QueryDataSource } from "./ai-types";

interface HttpRequest {
  body?: unknown;
  auth?: AuthContext;
  query?: Record<string, string | undefined>;
}

interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: unknown): void;
}

export interface MinimalHttpApp {
  post(path: string, handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): void;
  get(path: string, handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): void;
  delete(path: string, handler: (req: HttpRequest, res: HttpResponse) => Promise<void>): void;
}

class SqliteCompanyScopedDataSource implements QueryDataSource {
  constructor(private readonly db: DatabaseSync) {}

  async listOrders(scope: { companyId: string }): Promise<Order[]> {
    const rows = this.db
      .prepare(`
        SELECT
          id, company_id, client_id, item_name, product_quantity, package_count, package_unit,
          domestic_tracking_no, order_no, transport_mode, warehouse_id, batch_no,
          weight_kg, volume_m3, receiver_name_th, receiver_phone_th, receiver_address_th,
          status_group, created_at, updated_at
        FROM orders
        WHERE company_id = ?
        ORDER BY created_at DESC
      `)
      .all(scope.companyId) as Array<{
      id: string;
      company_id: string;
      client_id: string;
      item_name: string;
      product_quantity: number;
      package_count: number;
      package_unit: "bag" | "box" | null;
      domestic_tracking_no: string | null;
      order_no: string | null;
      transport_mode: "sea" | "land" | null;
      warehouse_id: string | null;
      batch_no: string | null;
      weight_kg: number | null;
      volume_m3: number | null;
      receiver_name_th: string | null;
      receiver_phone_th: string | null;
      receiver_address_th: string | null;
      status_group: "unfinished" | "completed" | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      clientId: r.client_id,
      pickupAddressCn: "",
      deliveryAddressTh: "",
      receiverName: r.receiver_name_th ?? "",
      receiverPhone: r.receiver_phone_th ?? "",
      serviceType: "standard",
      itemName: r.item_name,
      productQuantity: r.product_quantity ?? 0,
      packageCount: r.package_count ?? 0,
      packageUnit: r.package_unit ?? "box",
      domesticTrackingNo: r.domestic_tracking_no ?? undefined,
      orderNo: r.order_no ?? undefined,
      transportMode: r.transport_mode ?? undefined,
      warehouseId: r.warehouse_id ?? undefined,
      batchNo: r.batch_no ?? undefined,
      weightKg: r.weight_kg ?? undefined,
      volumeM3: r.volume_m3 ?? undefined,
      receiverNameTh: r.receiver_name_th ?? undefined,
      receiverPhoneTh: r.receiver_phone_th ?? undefined,
      receiverAddressTh: r.receiver_address_th ?? undefined,
      statusGroup: r.status_group ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async listShipments(scope: { companyId: string }): Promise<Shipment[]> {
    const rows = this.db
      .prepare(`
        SELECT
          id, company_id, order_id, tracking_no, current_status, current_location,
          weight_kg, volume_m3, package_count, package_unit, transport_mode,
          domestic_tracking_no, warehouse_id, batch_no, created_at, updated_at
        FROM shipments
        WHERE company_id = ?
        ORDER BY updated_at DESC
      `)
      .all(scope.companyId) as Array<{
      id: string;
      company_id: string;
      order_id: string;
      tracking_no: string;
      current_status: Shipment["currentStatus"];
      current_location: string | null;
      weight_kg: number | null;
      volume_m3: number | null;
      package_count: number | null;
      package_unit: "bag" | "box" | null;
      transport_mode: "sea" | "land" | null;
      domestic_tracking_no: string | null;
      warehouse_id: string | null;
      batch_no: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      orderId: r.order_id,
      trackingNo: r.tracking_no,
      currentStatus: r.current_status,
      currentLocation: r.current_location ?? undefined,
      weightKg: r.weight_kg ?? undefined,
      volumeM3: r.volume_m3 ?? undefined,
      packageCount: r.package_count ?? undefined,
      packageUnit: r.package_unit ?? undefined,
      transportMode: r.transport_mode ?? undefined,
      domesticTrackingNo: r.domestic_tracking_no ?? undefined,
      warehouseId: r.warehouse_id ?? undefined,
      batchNo: r.batch_no ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}

function jsonOk<T>(data: T): ApiResponse<T> {
  return {
    code: "OK",
    message: "success",
    data,
    timestamp: new Date().toISOString(),
  };
}

function jsonError(code: Exclude<ApiResponse<unknown>["code"], "OK">, message: string) {
  return {
    code,
    message,
    errors: [{ reason: message }],
    timestamp: new Date().toISOString(),
  };
}

export function registerClientAiRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  const auditStore = new SqliteAiAuditStore(db);
  const knowledgeGapStore = new SqliteAiKnowledgeGapStore(db);
  const statusLabelStore = new SqliteStatusLabelStore(db);
  const knowledgeStore = new SqliteAiKnowledgeStore(db);
  const memoryStore = new SqliteAiSessionMemoryStore(db);
  const service = new ClientAiService({
    dataSource: new SqliteCompanyScopedDataSource(db),
    auditStore,
    knowledgeGapStore,
    llmClient: new HttpDeepSeekClient(),
    statusLabelStore,
    knowledgeStore,
    memoryStore,
  });

  app.post("/client/ai/chat", async (req, res) => {
    try {
      const auth = req.auth;
      if (!auth) {
        res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
        return;
      }

      // Company scope is enforced by service-level query filtering.
      const response = await service.chat({
        auth,
        body: (req.body ?? {}) as AiChatRequest,
      });
      res.status(200).json(jsonOk(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message.startsWith("BAD_REQUEST:")) {
        res.status(400).json(jsonError("BAD_REQUEST", message.replace("BAD_REQUEST:", "").trim()));
        return;
      }
      if (message === "FORBIDDEN_ROLE") {
        res.status(403).json(jsonError("FORBIDDEN", "only client role can use ai chat"));
        return;
      }
      res.status(500).json(jsonError("INTERNAL_ERROR", message));
    }
  });

  app.get("/client/ai/suggestions", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "client") {
      res.status(403).json(jsonError("FORBIDDEN", "only client role can use ai suggestions"));
      return;
    }
    const data: AiSuggestionResponse = service.getSuggestions();
    res.status(200).json(jsonOk(data));
  });

  app.get("/admin/ai/audit-logs", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai audit logs"));
      return;
    }

    const companyId = req.query?.companyId ?? auth.companyId;
    const logs = await auditStore.listByCompany(companyId);
    res.status(200).json(jsonOk(logs));
  });

  app.get("/admin/ai/knowledge-gaps", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai knowledge gaps"));
      return;
    }
    const companyId = req.query?.companyId ?? auth.companyId;
    const statusRaw = req.query?.status?.trim();
    const status = statusRaw === "open" || statusRaw === "resolved" ? statusRaw : undefined;
    const list = await knowledgeGapStore.listByCompany(companyId, status);
    res.status(200).json(jsonOk({ items: list, total: list.length, status: status ?? "all" }));
  });

  app.post("/admin/ai/knowledge-gaps/resolve", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can resolve ai knowledge gaps"));
      return;
    }
    const payload = (req.body ?? {}) as { id?: string; companyId?: string };
    const id = payload.id?.trim();
    if (!id) {
      res.status(400).json(jsonError("BAD_REQUEST", "id is required"));
      return;
    }
    const companyId = payload.companyId ?? auth.companyId;
    const okResolved = await knowledgeGapStore.resolve({
      companyId,
      id,
      resolvedBy: auth.userId,
    });
    if (!okResolved) {
      res.status(404).json(jsonError("NOT_FOUND", "knowledge gap not found or already resolved"));
      return;
    }
    res.status(200).json(jsonOk({ resolved: true, id }));
  });

  app.get("/admin/ai/session-memory", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai session memory"));
      return;
    }
    const companyId = req.query?.companyId ?? auth.companyId;
    const limitRaw = req.query?.limit?.trim();
    const limit = limitRaw ? Number(limitRaw) : 200;
    const safeLimit = Number.isNaN(limit) ? 200 : Math.max(1, Math.min(limit, 1000));
    const list = await memoryStore.listByCompany(companyId);
    res.status(200).json(jsonOk({ items: list.slice(0, safeLimit), total: list.length, limit: safeLimit }));
  });

  app.delete("/admin/ai/session-memory", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can clear ai session memory"));
      return;
    }
    const companyId = req.query?.companyId ?? auth.companyId;
    const sessionId = req.query?.sessionId?.trim() || undefined;
    const userId = req.query?.userId?.trim() || undefined;
    const removed = await memoryStore.removeByFilter({ companyId, sessionId, userId });
    res.status(200).json(
      jsonOk({
        removed,
        companyId,
        sessionId: sessionId ?? null,
        userId: userId ?? null,
      }),
    );
  });

  app.get("/admin/system/status-labels", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    const items = await statusLabelStore.list();
    res.status(200).json(jsonOk(items));
  });

  app.post("/admin/system/status-labels", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    const payload = (req.body ?? {}) as { items?: StatusLabelConfig[] };
    const items = payload.items ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json(jsonError("BAD_REQUEST", "items is required"));
      return;
    }
    await statusLabelStore.upsert(items);
    res.status(200).json(jsonOk({ updated: items.length }));
  });

  app.post("/admin/system/status-labels/reset", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    await statusLabelStore.resetDefaults();
    const items = await statusLabelStore.list();
    res.status(200).json(jsonOk({ reset: true, total: items.length }));
  });

  app.get("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai knowledge"));
      return;
    }
    const companyId = req.query?.companyId ?? auth.companyId;
    const items = await knowledgeStore.list(companyId);
    res.status(200).json(jsonOk(items));
  });

  app.post("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can feed ai knowledge"));
      return;
    }
    const payload = (req.body ?? {}) as { title?: string; content?: string; companyId?: string };
    if (!payload.title?.trim() || !payload.content?.trim()) {
      res.status(400).json(jsonError("BAD_REQUEST", "title and content are required"));
      return;
    }
    const companyId = payload.companyId ?? auth.companyId;
    const created = await knowledgeStore.add({
      companyId,
      title: payload.title.trim(),
      content: payload.content.trim(),
      createdBy: auth.userId,
    });
    res.status(200).json(jsonOk(created));
  });

  app.delete("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can delete ai knowledge"));
      return;
    }
    const id = req.query?.id?.trim();
    if (!id) {
      res.status(400).json(jsonError("BAD_REQUEST", "id is required"));
      return;
    }
    const companyId = req.query?.companyId ?? auth.companyId;
    const deleted = await knowledgeStore.remove(companyId, id);
    if (!deleted) {
      res.status(404).json(jsonError("NOT_FOUND", "knowledge item not found"));
      return;
    }
    res.status(200).json(jsonOk({ deleted: true, id }));
  });
}
