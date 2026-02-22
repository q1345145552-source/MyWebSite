import type {
  AiKnowledgeItem,
  StatusLabelConfig,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import type { AiKnowledgeStore, StatusLabelStore } from "./ai-types";

export const DEFAULT_STATUS_LABELS: StatusLabelConfig[] = [
  { status: "created", labelZh: "已创建" },
  { status: "pickedUp", labelZh: "已揽收" },
  { status: "inWarehouseCN", labelZh: "中国仓已入库" },
  { status: "customsPending", labelZh: "清关待处理" },
  { status: "inTransit", labelZh: "运输中" },
  { status: "customsTH", labelZh: "泰国清关中" },
  { status: "outForDelivery", labelZh: "派送中" },
  { status: "delivered", labelZh: "已签收" },
  { status: "exception", labelZh: "异常" },
  { status: "returned", labelZh: "已退回" },
  { status: "cancelled", labelZh: "已取消" },
];

export class InMemoryStatusLabelStore implements StatusLabelStore {
  private readonly labels = new Map<ShipmentStatus, string>(
    DEFAULT_STATUS_LABELS.map((item) => [item.status, item.labelZh]),
  );

  async list(): Promise<StatusLabelConfig[]> {
    return Array.from(this.labels.entries()).map(([status, labelZh]) => ({ status, labelZh }));
  }

  async getLabel(status: ShipmentStatus): Promise<string | undefined> {
    return this.labels.get(status);
  }

  async upsert(items: StatusLabelConfig[]): Promise<void> {
    items.forEach((item) => {
      this.labels.set(item.status, item.labelZh);
    });
  }

  async resetDefaults(): Promise<void> {
    this.labels.clear();
    DEFAULT_STATUS_LABELS.forEach((item) => {
      this.labels.set(item.status, item.labelZh);
    });
  }
}

export class InMemoryAiKnowledgeStore implements AiKnowledgeStore {
  private readonly items: AiKnowledgeItem[] = [];

  async list(companyId: string): Promise<AiKnowledgeItem[]> {
    return this.items.filter((item) => item.companyId === companyId);
  }

  async add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem> {
    const created: AiKnowledgeItem = {
      ...item,
      id: `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.items.unshift(created);
    return created;
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.companyId === companyId && item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }
}
