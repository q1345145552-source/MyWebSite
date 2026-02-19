import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  Order,
  StatusLabelConfig,
  Shipment,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";

export interface AuthContext {
  userId: string;
  companyId: string;
  role: "admin" | "staff" | "client";
}

export interface QueryScope {
  companyId: string;
}

export interface QueryDataSource {
  listOrders(scope: QueryScope): Promise<Order[]>;
  listShipments(scope: QueryScope): Promise<Shipment[]>;
}

export interface AuditStore {
  add(log: AiQueryAuditLog): Promise<void>;
  listByCompany(companyId: string): Promise<AiQueryAuditLog[]>;
}

export interface DeepSeekClient {
  summarizeWithContext(input: {
    question: string;
    context: string;
  }): Promise<string>;
}

export interface StatusLabelStore {
  list(): Promise<StatusLabelConfig[]>;
  getLabel(status: ShipmentStatus): Promise<string | undefined>;
  upsert(items: StatusLabelConfig[]): Promise<void>;
  resetDefaults(): Promise<void>;
}

export interface AiKnowledgeStore {
  list(companyId: string): Promise<AiKnowledgeItem[]>;
  add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem>;
  remove(companyId: string, id: string): Promise<boolean>;
}

export interface AiService {
  getSuggestions(): AiSuggestionResponse;
  chat(input: {
    auth: AuthContext;
    body: AiChatRequest;
  }): Promise<AiChatResponse>;
}

export interface ShipmentProgressResult {
  shipment?: Shipment;
  latestStatus?: ShipmentStatus;
}
