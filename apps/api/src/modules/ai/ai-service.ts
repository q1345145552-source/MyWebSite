import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { AiQueryAuditLog, Shipment } from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import type {
  AiKnowledgeStore,
  AiService,
  AuditStore,
  AuthContext,
  DeepSeekClient,
  QueryDataSource,
  StatusLabelStore,
} from "./ai-types";

interface AiServiceDeps {
  dataSource: QueryDataSource;
  auditStore: AuditStore;
  llmClient: DeepSeekClient;
  statusLabelStore: StatusLabelStore;
  knowledgeStore: AiKnowledgeStore;
}

const SUGGESTIONS = [
  "我的单号 THCN0001 到哪了？",
  "我这个月一共发了多少货？",
  "最近 7 天在途订单有多少？",
];

const COMPLETED_STATUSES: ShipmentStatus[] = ["delivered", "returned", "cancelled"];

export class ClientAiService implements AiService {
  constructor(private readonly deps: AiServiceDeps) {}

  getSuggestions(): AiSuggestionResponse {
    return { suggestions: SUGGESTIONS };
  }

  async chat(input: { auth: AuthContext; body: AiChatRequest }): Promise<AiChatResponse> {
    const { auth, body } = input;
    this.assertClientRole(auth);

    const orders = await this.deps.dataSource.listOrders({ companyId: auth.companyId });
    const shipments = await this.deps.dataSource.listShipments({ companyId: auth.companyId });
    const knowledgeItems = await this.deps.knowledgeStore.list(auth.companyId);

    const trackingNo = this.extractTrackingNo(body.message);
    let answerDraft: string;
    let evidenceShipmentIds: string[] = [];
    let evidenceOrderIds: string[] = [];

    if (trackingNo) {
      const shipment = shipments.find((item) => item.trackingNo === trackingNo);
      if (!shipment) {
        answerDraft = this.formatNotFoundAnswer(trackingNo);
      } else {
        answerDraft = await this.formatProgressAnswer(shipment);
        evidenceShipmentIds = [shipment.id];
        evidenceOrderIds = [shipment.orderId];
      }
    } else {
      const summary = this.buildCompanySummary(shipments);
      answerDraft = this.formatSummaryAnswer(summary);
      evidenceShipmentIds = shipments.map((item) => item.id);
      evidenceOrderIds = orders.map((item) => item.id);
    }

    const llmContext = JSON.stringify(
      {
        companyId: auth.companyId,
        question: body.message,
        answerDraft,
        knowledgeItems: knowledgeItems.slice(0, 8).map((item) => ({
          id: item.id,
          title: item.title,
          content: item.content,
        })),
        evidenceShipmentIds,
        evidenceOrderIds,
      },
      null,
      2,
    );
    const refinedAnswer = await this.refineAnswerWithModel(body.message, llmContext, answerDraft);

    const response: AiChatResponse = {
      sessionId: body.sessionId ?? `sess_${Date.now()}`,
      answer: refinedAnswer,
      evidence: {
        orderIds: evidenceOrderIds,
        shipmentIds: evidenceShipmentIds,
        updatedAt: new Date().toISOString(),
      },
    };

    const auditLog: AiQueryAuditLog = {
      id: `aiq_${Date.now()}`,
      userId: auth.userId,
      companyId: auth.companyId,
      sessionId: response.sessionId,
      question: body.message,
      answerSummary: response.answer.slice(0, 200),
      referencedOrderIds: response.evidence.orderIds,
      referencedShipmentIds: response.evidence.shipmentIds,
      queriedAt: new Date().toISOString(),
    };
    await this.deps.auditStore.add(auditLog);

    return response;
  }

  private assertClientRole(auth: AuthContext): void {
    if (auth.role !== "client") {
      throw new Error("FORBIDDEN_ROLE");
    }
  }

  private extractTrackingNo(message: string): string | undefined {
    const match = message.match(/[A-Za-z]{2,}\d{3,}/);
    return match?.[0]?.toUpperCase();
  }

  private buildCompanySummary(shipments: Shipment[]): {
    totalCount: number;
    inTransitCount: number;
    completedCount: number;
    totalWeightKg: number;
    totalVolumeM3: number;
  } {
    return shipments.reduce(
      (acc, item) => {
        acc.totalCount += 1;
        if (item.currentStatus === "inTransit") {
          acc.inTransitCount += 1;
        }
        if (COMPLETED_STATUSES.includes(item.currentStatus)) {
          acc.completedCount += 1;
        }
        acc.totalWeightKg += item.weightKg ?? 0;
        acc.totalVolumeM3 += item.volumeM3 ?? 0;
        return acc;
      },
      {
        totalCount: 0,
        inTransitCount: 0,
        completedCount: 0,
        totalWeightKg: 0,
        totalVolumeM3: 0,
      },
    );
  }

  private async refineAnswerWithModel(
    question: string,
    llmContext: string,
    fallbackAnswer: string,
  ): Promise<string> {
    try {
      const refined = await this.deps.llmClient.summarizeWithContext({
        question: `${question}\n请严格使用“业务客服模板”风格输出，保持字段齐全。`,
        context: llmContext,
      });
      if (!refined?.trim()) return fallbackAnswer;
      return refined;
    } catch {
      // Model failure should not block core business answer.
      return fallbackAnswer;
    }
  }

  private formatNotFoundAnswer(trackingNo: string): string {
    return [
      "【查询结论】",
      `未找到运单号：${trackingNo}`,
      "",
      "【可能原因】",
      "1) 运单号输入有误",
      "2) 订单刚创建，物流信息尚未同步",
      "",
      "【建议操作】",
      "请核对运单号后重试，或提供国内快递单号给客服协助查询。",
    ].join("\n");
  }

  private async formatProgressAnswer(shipment: Shipment): Promise<string> {
    const statusLabel =
      (await this.deps.statusLabelStore.getLabel(shipment.currentStatus)) ?? shipment.currentStatus;
    return [
      "【查询结论】",
      `运单号：${shipment.trackingNo}`,
      `当前状态：${statusLabel}（${shipment.currentStatus}）`,
      `最近位置：${shipment.currentLocation ?? "暂无定位信息"}`,
      `最近更新时间：${shipment.updatedAt}`,
      "",
      "【建议操作】",
      shipment.currentStatus === "delivered"
        ? "该运单已签收，建议核对收货数量并归档。"
        : "该运单仍在运输流程中，建议稍后再次查询最新节点。",
    ].join("\n");
  }

  private formatSummaryAnswer(summary: {
    totalCount: number;
    inTransitCount: number;
    completedCount: number;
    totalWeightKg: number;
    totalVolumeM3: number;
  }): string {
    return [
      "【汇总结论】",
      "统计范围：当前公司账号数据",
      `运单总量：${summary.totalCount} 单`,
      `在途运单：${summary.inTransitCount} 单`,
      `已完成运单：${summary.completedCount} 单`,
      `总重量：${summary.totalWeightKg.toFixed(2)} kg`,
      `总体积：${summary.totalVolumeM3.toFixed(3)} m3`,
      "",
      "【建议操作】",
      "建议优先跟进在途与异常单，减少时效风险并提升签收率。",
    ].join("\n");
  }
}
