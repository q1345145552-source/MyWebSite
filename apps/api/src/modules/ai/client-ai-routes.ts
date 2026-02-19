import type {
  AiChatRequest,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { Order, Shipment, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import { InMemoryAiAuditStore } from "./ai-audit-store";
import { InMemoryAiKnowledgeStore, InMemoryStatusLabelStore } from "./ai-config-store";
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

class InMemoryCompanyScopedDataSource implements QueryDataSource {
  constructor(
    private readonly orders: Order[],
    private readonly shipments: Shipment[],
  ) {}

  async listOrders(scope: { companyId: string }): Promise<Order[]> {
    return this.orders.filter((item) => item.companyId === scope.companyId);
  }

  async listShipments(scope: { companyId: string }): Promise<Shipment[]> {
    return this.shipments.filter((item) => item.companyId === scope.companyId);
  }
}

const seedOrders: Order[] = [
  {
    id: "o_001",
    companyId: "c_001",
    clientId: "u_client_001",
    pickupAddressCn: "Guangzhou",
    deliveryAddressTh: "Bangkok",
    receiverName: "Somchai",
    receiverPhone: "0812345678",
    serviceType: "standard",
    itemName: "手机壳",
    productQuantity: 200,
    packageCount: 12,
    packageUnit: "box",
    domesticTrackingNo: "SF12345678",
    transportMode: "sea",
    receiverNameTh: "Somchai",
    receiverPhoneTh: "0812345678",
    receiverAddressTh: "Bangkok",
    createdAt: "2026-02-18T08:00:00.000Z",
  },
];

const seedShipments: Shipment[] = [
  {
    id: "s_001",
    companyId: "c_001",
    orderId: "o_001",
    trackingNo: "THCN0001",
    currentStatus: "inTransit",
    currentLocation: "Bangkok Hub",
    weightKg: 120.5,
    volumeM3: 1.28,
    packageCount: 12,
    packageUnit: "box",
    transportMode: "sea",
    domesticTrackingNo: "SF12345678",
    warehouseId: "wh_bkk_01",
    createdAt: "2026-02-18T08:00:00.000Z",
    updatedAt: "2026-02-18T09:00:00.000Z",
  },
];

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

export function registerClientAiRoutes(app: MinimalHttpApp): void {
  const auditStore = new InMemoryAiAuditStore();
  const statusLabelStore = new InMemoryStatusLabelStore();
  const knowledgeStore = new InMemoryAiKnowledgeStore();
  const service = new ClientAiService({
    dataSource: new InMemoryCompanyScopedDataSource(seedOrders, seedShipments),
    auditStore,
    llmClient: new HttpDeepSeekClient(),
    statusLabelStore,
    knowledgeStore,
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
      if (message === "FORBIDDEN_ROLE") {
        res.status(403).json(jsonError("FORBIDDEN", "only client role can use ai chat"));
        return;
      }
      res.status(500).json(jsonError("INTERNAL_ERROR", message));
    }
  });

  app.get("/client/ai/suggestions", async (_req, res) => {
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
