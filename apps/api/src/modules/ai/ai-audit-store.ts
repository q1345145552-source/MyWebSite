import type { AiQueryAuditLog } from "../../../../../packages/shared-types/entities";
import type { AuditStore } from "./ai-types";

export class InMemoryAiAuditStore implements AuditStore {
  private readonly logs: AiQueryAuditLog[] = [];

  async add(log: AiQueryAuditLog): Promise<void> {
    this.logs.unshift(log);
  }

  async listByCompany(companyId: string): Promise<AiQueryAuditLog[]> {
    return this.logs.filter((item) => item.companyId === companyId);
  }
}
