/**
 * AI 客服答复的「数字对不对」自测（不连数据库、不连 DeepSeek）。
 *
 * 覆盖 2026-08-28 一起修的三条 —— 少修任何一条，客户看到的数字都还是错的：
 *   1. 模型润色时改了数字，没人核对         → ai-service.ts refineAnswerWithModel/enforceDraftNumbers
 *   2. 「今天/本月」按服务器时区（UTC）算，比北京时间早 8 小时 → resolveTimeWindow
 *   3. 时间筛选用 updatedAt（最后更新）而不是 createdAt（下单） → inTimeWindow
 *
 * ⚠️ 必须在 **两个时区**下各跑一遍（见 package.json 的 test:ai-numbers）：
 *   生产容器是 UTC，开发机在中国是 UTC+8。第 2 条的 bug 只在 UTC 下暴露 ——
 *   这正是「本地测没问题、线上数字不对」反复发生的原因。
 */
import assert from "node:assert/strict";
import { ClientAiService } from "../apps/api/src/modules/ai/ai-service";
import type {
  AiKnowledgeGapRecord,
  AiSessionMemoryRecord,
  AuthContext,
  QueryScope,
} from "../apps/api/src/modules/ai/ai-types";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  Order,
  Shipment,
  StatusLabelConfig,
} from "../packages/shared-types/entities";
import type { ShipmentStatus } from "../packages/shared-types/shipment-status";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const TZ_LABEL = process.env.TZ ?? "(系统默认)";

const AUTH: AuthContext = { userId: "u_client_1", companyId: "c_1", role: "client" };

/** 北京当天零点对应的真实时刻（UTC 毫秒） */
function beijingMidnightMs(dayDelta = 0): number {
  const beijing = new Date(Date.now() + CHINA_OFFSET_MS);
  beijing.setUTCHours(0, 0, 0, 0);
  beijing.setUTCDate(beijing.getUTCDate() + dayDelta);
  return beijing.getTime() - CHINA_OFFSET_MS;
}

/** 北京「本月 1 号」零点对应的真实时刻 */
function beijingMonthStartMs(): number {
  const beijing = new Date(Date.now() + CHINA_OFFSET_MS);
  return Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), 1) - CHINA_OFFSET_MS;
}

function shipment(input: {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  status?: ShipmentStatus;
  weightKg?: number;
}): Shipment {
  return {
    id: input.id,
    companyId: AUTH.companyId,
    orderId: `o_${input.id}`,
    trackingNo: `TH${input.id.toUpperCase()}`,
    currentStatus: input.status ?? "loaded",
    weightKg: input.weightKg ?? 0,
    volumeM3: 0,
    packageCount: 1,
    transportMode: "sea",
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt: new Date(input.updatedAtMs).toISOString(),
  } as Shipment;
}

function order(id: string): Order {
  return {
    id: `o_${id}`,
    companyId: AUTH.companyId,
    clientId: AUTH.userId,
    pickupAddressCn: "",
    deliveryAddressTh: "",
    receiverName: "",
    receiverPhone: "",
    serviceType: "standard",
    itemName: "测试品名",
    productQuantity: 1,
    packageCount: 1,
  } as Order;
}

/** 模型桩：意图解析那次一律返回空（走规则解析），润色那次交给测试自己决定 */
function buildService(input: {
  shipments: Shipment[];
  polish: (draft: string) => string;
}) {
  const memoryRows = new Map<string, AiSessionMemoryRecord>();
  const audits: AiQueryAuditLog[] = [];
  return {
    audits,
    service: new ClientAiService({
      dataSource: {
        async listOrders(_scope: QueryScope): Promise<Order[]> {
          return input.shipments.map((s) => order(s.id));
        },
        async listShipments(_scope: QueryScope): Promise<Shipment[]> {
          return input.shipments;
        },
      },
      auditStore: {
        async add(log: AiQueryAuditLog) {
          audits.push(log);
        },
        async listByCompany() {
          return audits;
        },
      },
      knowledgeGapStore: {
        async add(_record: AiKnowledgeGapRecord) {},
        async listByCompany() {
          return [];
        },
        async resolve() {
          return true;
        },
      },
      llmClient: {
        async summarizeWithContext({ question, context }) {
          if (question.includes("意图解析器")) return "";
          const parsed = JSON.parse(context) as { answerDraft?: string };
          return input.polish(parsed.answerDraft ?? "");
        },
      },
      statusLabelStore: {
        async list(): Promise<StatusLabelConfig[]> {
          return [];
        },
        async getLabel() {
          return undefined;
        },
        async upsert() {},
        async resetDefaults() {},
      },
      knowledgeStore: {
        async list(): Promise<AiKnowledgeItem[]> {
          return [];
        },
        async add(item) {
          return { ...item, id: "k_1", createdAt: new Date().toISOString() } as AiKnowledgeItem;
        },
        async remove() {
          return true;
        },
      },
      memoryStore: {
        async get(key: string) {
          return memoryRows.get(key);
        },
        async set(record: AiSessionMemoryRecord) {
          memoryRows.set(record.key, record);
        },
        async cleanupOlderThan() {},
        async listByCompany() {
          return Array.from(memoryRows.values());
        },
        async removeByFilter() {
          return 0;
        },
      },
    }),
  };
}

async function ask(input: {
  shipments: Shipment[];
  message: string;
  polish?: (draft: string) => string;
}) {
  const { service, audits } = buildService({
    shipments: input.shipments,
    polish: input.polish ?? (() => ""),
  });
  const response = await service.chat({
    auth: AUTH,
    body: { message: input.message, sessionId: `sess_test_${Math.random()}` },
  });
  return { answer: response.answer, audit: audits[0] };
}

function totalCountOf(answer: string): number {
  const matched = answer.match(/总单量：(\d+) 单/);
  assert.ok(matched, `答复里没有「总单量」这一行：\n${answer}`);
  return Number(matched[1]);
}

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

async function main() {
  const nowMs = Date.now();
  console.log(`AI 答复数字校验（TZ=${TZ_LABEL}）`);

  // ── 1. 模型把算好的数字改了 → 必须整段退回原始草稿 ────────────────────────
  await check("1) 模型改了数字 → 整段退回原始草稿", async () => {
    const shipments = [
      shipment({ id: "a1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "a2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "a3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      // 复刻生产事故：真实 367，模型答 726
      polish: (draft) => draft.replace(/总单量：\d+ 单/, "总单量：726 单"),
    });
    assert.equal(totalCountOf(answer), 3, "模型改过的数字被发给客户了");
    assert.ok(!answer.includes("726"), "模型编的 726 出现在最终答复里");
  });

  // ── 2. 数字没被动 → 允许模型润色，不能一刀切退回草稿 ─────────────────────
  await check("2) 数字没被动 → 允许润色", async () => {
    const shipments = [shipment({ id: "b1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: (draft) => `亲，帮你查好了。\n${draft}\n有问题随时找我。`,
    });
    assert.ok(answer.includes("亲，帮你查好了"), "数字没被动时润色稿被误杀了");
    assert.equal(totalCountOf(answer), 1);
  });

  // ── 3. 千位分隔符不算「改了数字」（1,234.56 和 1234.56 是同一个数）────────
  await check("3) 千位分隔符不算改数字", async () => {
    const shipments = [
      shipment({ id: "c1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, weightKg: 1234.56 }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: (draft) => draft.replace("1234.56", "1,234.56"),
    });
    assert.ok(answer.includes("1,234.56"), "只是加了千位分隔符，不该判成改数字");
  });

  // ── 4. 审计日志存的必须是最终发出去的那句（校验后的）──────────────────────
  await check("4) 审计日志存的是校验后的答复", async () => {
    const shipments = [shipment({ id: "d1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, audit } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: (draft) => draft.replace(/总单量：\d+ 单/, "总单量：999 单"),
    });
    assert.ok(!audit.answerSummary.includes("999"), "审计日志里存了模型编的数字");
    assert.ok(answer.startsWith(audit.answerSummary.slice(0, 20)));
  });

  // ── 5.「今天」按北京时间：北京今天 0 点刚过下的单必须算今天 ────────────────
  //    ⚠️ 第 5、6 条必须成对存在，缺一条就抓不住 bug：
  //    旧代码的「今天」= 北京昨天 8 点 → 今天 8 点（整体偏了 8 小时）。
  //    北京时间 0-8 点跑测试时，第 5 条会侥幸通过、第 6 条挂；
  //    8 点之后跑则反过来。两条一起才保证任何时刻跑都能抓到。
  await check("5) 「今天」按北京时间：凌晨的单算今天", async () => {
    const justAfterBeijingMidnight = beijingMidnightMs(0) + 1000;
    assert.ok(justAfterBeijingMidnight <= nowMs, "跑测试的时刻正好卡在北京 0 点整，请稍后重试");
    const shipments = [
      shipment({ id: "e1", createdAtMs: justAfterBeijingMidnight, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我今天发了多少单" });
    assert.equal(totalCountOf(answer), 1, `北京今天凌晨的单没算进「今天」（TZ=${TZ_LABEL}）`);
  });

  // ── 6.「今天」不能把北京昨天 23:59 的单算进来 ──────────────────────────────
  await check("6) 「今天」不含北京昨天深夜的单", async () => {
    const beforeBeijingMidnight = beijingMidnightMs(0) - 60_000;
    const shipments = [
      shipment({ id: "f1", createdAtMs: beforeBeijingMidnight, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我今天发了多少单" });
    assert.equal(totalCountOf(answer), 0, `北京昨天深夜的单被算进了「今天」（TZ=${TZ_LABEL}）`);
  });

  // ── 7.「本月」按下单时间，不按最后更新时间 ────────────────────────────────
  //    半年前的老单这个月刚推进过状态 → 不算本月；本月 1 号凌晨下的单 → 算本月
  await check("7) 「本月」按下单时间，不按最后更新时间", async () => {
    const halfYearAgo = nowMs - 180 * 86400_000;
    const shipments = [
      shipment({ id: "g_old", createdAtMs: halfYearAgo, updatedAtMs: nowMs }),
      shipment({ id: "g_new", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    // 两种问法都要走统计分支：推荐问题里那句用的是「多少货」，
    // 但客户随口会说「多少单」——后者曾被当成品名查询（见 normalizeProductKeyword 的注释）
    for (const message of ["我这个月一共发了多少货？", "我这个月一共发了多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.equal(
        totalCountOf(answer),
        1,
        `「本月」口径不对（问法：${message}，TZ=${TZ_LABEL}）：\n${answer}`,
      );
    }
  });

  // ── 8. 分柜的父子单仍然只算一票（别让这轮改动碰坏 2026-08-25 的合并逻辑）──
  await check("8) 分柜父子单仍然只算一票", async () => {
    const created = nowMs - 86400_000;
    const parent = shipment({ id: "h_p", createdAtMs: created, updatedAtMs: nowMs });
    const child = {
      ...shipment({ id: "h_c", createdAtMs: nowMs - 3600_000, updatedAtMs: nowMs }),
      trackingNo: `${parent.trackingNo}-2`,
      parentTrackingNo: parent.trackingNo,
    } as Shipment;
    const { answer } = await ask({ shipments: [parent, child], message: "我在途有多少单" });
    assert.equal(totalCountOf(answer), 1, "父单+子单被数成了两票");
  });

  // ── 9. 系统自己推荐给客户的统计问题，必须都走统计、都带上正确的时间范围 ──────
  //    实测过的三种误判：整句被当成品名（「我这个月一共发了」「今日发了」「天异常件」）、
  //    以及「这个月」不认识导致一个时间筛选都不走、直接报开户至今的总数。
  await check("9) 推荐问题都能正确解析出时间范围", async () => {
    const shipments = [
      shipment({ id: "i1", createdAtMs: beijingMidnightMs(0) + 1000, updatedAtMs: nowMs }),
    ];
    const cases: Array<[string, string]> = [
      ["我这个月一共发了多少货？", "本月"],
      ["我这个月一共发了多少单", "本月"],
      ["我这个月发货总重量是多少？", "本月"],
      ["本月已完成订单有多少？", "本月"],
      ["最近 7 天在途订单有多少？", "最近7天"],
      ["最近 3 天异常件有多少？", "最近3天"],
      ["我今天发了多少单", "今天"],
      ["今日发了多少单", "今天"],
      ["昨天发了多少单", "昨天"],
      ["本周发了多少单", "本周"],
      ["这周发了多少单", "本周"],
    ];
    for (const [message, expectedLabel] of cases) {
      const { answer } = await ask({ shipments, message });
      assert.ok(
        !answer.includes("未查询到品名"),
        `「${message}」被当成品名查询了：\n${answer}`,
      );
      assert.ok(
        answer.includes(`查询范围：${expectedLabel}，`),
        `「${message}」的时间范围不是「${expectedLabel}」：\n${answer}`,
      );
    }
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length}/9 项不通过（TZ=${TZ_LABEL}）：${failures.join("；")}`);
  }
  console.log(`AI 答复数字校验：9 项全部通过（TZ=${TZ_LABEL}）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
