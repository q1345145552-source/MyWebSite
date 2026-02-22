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

export interface AiKnowledgeGapRecord {
  id: string;
  companyId: string;
  userId: string;
  sessionId?: string;
  question: string;
  answerSummary: string;
  knowledgeCountAtAsk: number;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface AiKnowledgeGapStore {
  add(record: AiKnowledgeGapRecord): Promise<void>;
  listByCompany(companyId: string, status?: "open" | "resolved"): Promise<AiKnowledgeGapRecord[]>;
  resolve(input: { companyId: string; id: string; resolvedBy: string }): Promise<boolean>;
}

export interface AiService {
  getSuggestions(): AiSuggestionResponse;
  chat(input: {
    auth: AuthContext;
    body: AiChatRequest;
  }): Promise<AiChatResponse>;
}

export interface AiSessionMemoryRecord {
  key: string;
  companyId: string;
  userId: string;
  sessionId: string;
  intent?: "tracking" | "summary";
  itemName?: string;
  statusScope?: "all" | "inTransit" | "completed" | "unfinished" | "exception";
  timeHint?: string;
  metric?: "count" | "volume" | "weight" | "mixed";
  updatedAt: string;
}

export interface AiSessionMemoryStore {
  get(key: string): Promise<AiSessionMemoryRecord | undefined>;
  set(record: AiSessionMemoryRecord): Promise<void>;
  cleanupOlderThan(iso: string): Promise<void>;
  listByCompany(companyId: string): Promise<AiSessionMemoryRecord[]>;
  removeByFilter(input: {
    companyId: string;
    sessionId?: string;
    userId?: string;
  }): Promise<number>;
}

export interface ShipmentProgressResult {
  shipment?: Shipment;
  latestStatus?: ShipmentStatus;
}
