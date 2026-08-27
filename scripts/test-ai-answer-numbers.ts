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
  AiOrder,
  AiSessionMemoryRecord,
  AuthContext,
  QueryScope,
} from "../apps/api/src/modules/ai/ai-types";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  Shipment,
  StatusLabelConfig,
} from "../packages/shared-types/entities";
import type { ShipmentStatus } from "../packages/shared-types/shipment-status";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const TZ_LABEL = process.env.TZ ?? "(系统默认)";

const AUTH: AuthContext = { userId: "u_client_1", companyId: "c_1", role: "client" };

/**
 * ⚠️ 模型桩必须**真的改到草稿**，否则测试就是假绿。
 *
 * 2026-08-28 复核抓到的教训：第 1、4 项原来写死替换「总单量：N 单」，
 * 后来「在途」范围的答复改成打「符合条件：N 单」，正则不再匹配 →
 * 桩返回的就是原文 → `enforceDraftNumbers` 第一行 `polished === draft` 直接返回 →
 * 两项测试一路绿灯，**其实一次都没验到数字校验**。
 * 现在只要正则没匹配上就当场断言失败，答复格式再变也瞒不过去。
 */
/**
 * 把草稿里第 a、b 个「数据记号」对调。
 *
 * ⚠️ 这个辅助要能同时对付两种草稿：改造前桩收到的是**真数字**（`10 单`），
 * 改造后收到的是**占位符**（`⟦N1⟧`）。写死其中一种，另一种会因为匹配不到而
 * 「测试假失败」——看起来像 bug，其实是桩没写对。
 */
const TOKEN_RE = /⟦N\d+⟧|-?\d+(?:\.\d+)?\s*(?:千克|公斤|kg|立方米|立方|方|m³|单|票|张|件|箱)|\d{1,2}:\d{2}/g;
function swapTokens(a: number, b: number) {
  return (draft: string): string => {
    const hits = draft.match(TOKEN_RE) ?? [];
    assert.ok(hits.length > Math.max(a, b), `草稿里数据记号不够（只有 ${hits.length} 个）：\n${draft}`);
    let i = -1;
    return draft.replace(TOKEN_RE, (m) => {
      i += 1;
      if (i === a) return hits[b]!;
      if (i === b) return hits[a]!;
      return m;
    });
  };
}
/** 把第 n 个数据记号替换成 replacement（真数字/占位符两种草稿都适用） */
function replaceToken(n: number, replacement: string) {
  return (draft: string): string => {
    const hits = draft.match(TOKEN_RE) ?? [];
    assert.ok(hits.length > n, `草稿里数据记号不够（只有 ${hits.length} 个）：\n${draft}`);
    let i = -1;
    return draft.replace(TOKEN_RE, (m) => {
      i += 1;
      return i === n ? replacement : m;
    });
  };
}

function rewriteDraft(...edits: Array<[RegExp, string]>) {
  return (draft: string): string => {
    let next = draft;
    for (const [pattern, replacement] of edits) {
      const applied = next.replace(pattern, replacement);
      assert.notEqual(applied, next, `测试桩没改到草稿（${pattern} 没匹配上）：\n${draft}`);
      next = applied;
    }
    return next;
  };
}

/** 单量那一行：「全部运单」打「总单量」，按状态筛过打「符合条件」 */
const COUNT_LINE = /(总单量|符合条件)：\d+ 单/;

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
  /** 不传 = 这一单**没填**重量/体积（不是 0）—— 空值不能显示成 0 */
  weightKg?: number;
  volumeM3?: number;
  orderId?: string;
  trackingNo?: string;
  parentTrackingNo?: string;
}): Shipment {
  return {
    id: input.id,
    companyId: AUTH.companyId,
    orderId: input.orderId ?? `o_${input.id}`,
    trackingNo: input.trackingNo ?? `TH${input.id.toUpperCase()}`,
    ...(input.parentTrackingNo ? { parentTrackingNo: input.parentTrackingNo } : {}),
    currentStatus: input.status ?? "loaded",
    ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
    ...(input.volumeM3 === undefined ? {} : { volumeM3: input.volumeM3 }),
    packageCount: 1,
    transportMode: "sea",
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt: new Date(input.updatedAtMs).toISOString(),
  } as Shipment;
}

/**
 * 品名可以按运单 id 单独指定。
 * `itemName` 是订单上那个「第一个货品」，`productNames` 是全部货品行 ——
 * 这两者不一致正是「耳机排第二个查不到」那个 bug 的现场。
 */
const orderNames = new Map<string, { itemName: string; productNames: string[] }>();
/** 订单级的整票重量/体积；设了它就以它为准（跟运单列表同口径） */
const orderTotals = new Map<string, { weightKg?: number; volumeM3?: number }>();

function order(id: string): AiOrder {
  const named = orderNames.get(id);
  const totals = orderTotals.get(id);
  return {
    id: `o_${id}`,
    ...(totals?.weightKg === undefined ? {} : { weightKg: totals.weightKg }),
    ...(totals?.volumeM3 === undefined ? {} : { volumeM3: totals.volumeM3 }),
    companyId: AUTH.companyId,
    clientId: AUTH.userId,
    pickupAddressCn: "",
    deliveryAddressTh: "",
    receiverName: "",
    receiverPhone: "",
    serviceType: "standard",
    itemName: named?.itemName ?? "测试品名",
    productNames: named?.productNames ?? [named?.itemName ?? "测试品名"],
    productQuantity: 1,
    packageCount: 1,
  } as AiOrder;
}

/** 模型桩：意图解析那次一律返回空（走规则解析），润色那次交给测试自己决定 */
function buildService(input: {
  shipments: Shipment[];
  polish: (draft: string) => string;
  /** 意图解析那次调用返回什么（默认返回空串，让它退回规则解析） */
  intent?: string;
  /** 记下每次发给模型的上下文，用来验证有没有塞没用的东西进去 */
  contexts?: string[];
}) {
  const memoryRows = new Map<string, AiSessionMemoryRecord>();
  const audits: AiQueryAuditLog[] = [];
  return {
    audits,
    service: new ClientAiService({
      dataSource: {
        async listOrders(_scope: QueryScope): Promise<AiOrder[]> {
          // 一张订单可能挂着父单 + 多个子单，这里按 orderId 去重
          const seen = new Set<string>();
          const result: AiOrder[] = [];
          for (const item of input.shipments) {
            const key = item.orderId.replace(/^o_/, "");
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(order(key));
          }
          return result;
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
          input.contexts?.push(context);
          if (question.includes("意图解析器")) return input.intent ?? "";
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
  intent?: string;
}) {
  const contexts: string[] = [];
  const { service, audits } = buildService({
    shipments: input.shipments,
    polish: input.polish ?? (() => ""),
    intent: input.intent,
    contexts,
  });
  const response = await service.chat({
    auth: AUTH,
    body: { message: input.message, sessionId: `sess_test_${Math.random()}` },
  });
  return { answer: response.answer, audit: audits[0], contexts };
}

/**
 * 「总单量」只在查询范围是「全部运单」时才打；
 * 按状态筛过之后打的是「符合条件」——因为那时候「已完成：0 单」是筛出来的假象，不能打。
 */
function totalCountOf(answer: string): number {
  const matched = answer.match(/(?:总单量|符合条件)：(\d+) 单/);
  assert.ok(matched, `答复里没有单量那一行：\n${answer}`);
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
      polish: rewriteDraft([COUNT_LINE, "$1：726 单"]),
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
  await check("3) 模型想给数字换个写法（加千位分隔符）→ 客户看到的仍是系统的原样", async () => {
    /**
     * ⚠️ 这一项的预期在 2026-08-28 变了，不是放宽而是收紧。
     * 旧契约：模型能看到 `1234.56`，把它写成 `1,234.56` 属于「没改数值」，放行。
     * 新契约（占位符方案）：模型看到的是 ⟦N⟧，**根本碰不到数字**。
     * 它若在占位符之外自己写出 `1,234.56`，那就是凭空造数 —— 必须退回原始草稿。
     * 客户最终看到的永远是系统格式化的那个数。
     */
    const shipments = [
      shipment({ id: "c1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, weightKg: 1234.56 }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: (draft) => `${draft}\n（合计约 1,234.56 千克）`,
    });
    assert.ok(!answer.includes("1,234.56"), `模型自己写的数字发给了客户：\n${answer}`);
    assert.ok(answer.includes("1234.56"), `系统算好的数字丢了：\n${answer}`);
  });

  // ── 4. 审计日志存的必须是最终发出去的那句（校验后的）──────────────────────
  await check("4) 审计日志存的是校验后的答复", async () => {
    const shipments = [shipment({ id: "d1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, audit } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: rewriteDraft([COUNT_LINE, "$1：999 单"]),
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

  // ── 10. 品名统计：多品名订单、空品名、反向包含 ────────────────────────────
  await check("10) 品名排在第二个的货也能查到", async () => {
    orderNames.set("j1", { itemName: "手机壳", productNames: ["手机壳", "耳机"] });
    orderNames.set("j2", { itemName: "数据线", productNames: ["数据线"] });
    const shipments = [
      shipment({ id: "j1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "j2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "耳机订单有多少单？" });
    assert.ok(!answer.includes("未查询到品名"), `耳机那张单没查到：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
    assert.ok(
      answer.includes("其中 1 单同时还有别的品名"),
      `没有说明这单还夹着别的货：\n${answer}`,
    );
  });

  await check("11) 空品名的订单不会被算进任何品名的统计", async () => {
    // 下单接口对品名只做 trim、不校验非空，所以空品名进得来。
    // 旧写法 keyword.includes("") 恒为真 → 这张单会被算进每一个品名的查询。
    orderNames.set("k1", { itemName: "", productNames: [""] });
    orderNames.set("k2", { itemName: "耳机", productNames: ["耳机"] });
    const shipments = [
      shipment({ id: "k1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "k2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "耳机订单有多少单？" });
    assert.equal(totalCountOf(answer), 1, `空品名那张单被算进来了：\n${answer}`);
  });

  await check("12) 品名「壳」的单不会被算进「手机壳」的查询", async () => {
    orderNames.set("m1", { itemName: "壳", productNames: ["壳"] });
    const shipments = [shipment({ id: "m1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "手机壳订单有多少单？" });
    assert.ok(
      answer.includes("未查询到品名") || totalCountOf(answer) === 0,
      `「壳」被算进「手机壳」了：\n${answer}`,
    );
  });

  await check("13) 查不到时仍然提示相近品名（宽松匹配只用在提示上）", async () => {
    orderNames.set("n1", { itemName: "壳", productNames: ["壳"] });
    const shipments = [shipment({ id: "n1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "手机壳订单有多少单？" });
    assert.ok(answer.includes("壳"), `没给出相近品名提示：\n${answer}`);
  });

  await check("14) 认品名时认最长的那个，一个字的品名不认", async () => {
    // 客户同时有「壳」和「手机壳」：问「手机壳」不能先撞上「壳」把两种货一起算进去。
    orderNames.set("p1", { itemName: "壳", productNames: ["壳"] });
    orderNames.set("p2", { itemName: "手机壳", productNames: ["手机壳"] });
    const shipments = [
      shipment({ id: "p1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我的手机壳还有多少货没完成？" });
    assert.ok(answer.includes("品名：手机壳"), `没认成手机壳：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `把「壳」那张单也算进来了：\n${answer}`);
  });

  await check("15) 品名叫「货」的客户，问「这个月发了多少货」不会被当成品名查询", async () => {
    orderNames.set("q1", { itemName: "货", productNames: ["货"] });
    orderNames.set("q2", { itemName: "耳机", productNames: ["耳机"] });
    const shipments = [
      shipment({ id: "q1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
      shipment({ id: "q2", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我这个月一共发了多少货？" });
    assert.ok(answer.includes("全部品类"), `被当成品名「货」查询了：\n${answer}`);
    assert.equal(totalCountOf(answer), 2);
  });

  // ── 16~19. 这一轮收尾的四条 ───────────────────────────────────────────────
  await check("16) 按状态筛之后不再打自相矛盾的「已完成：0 单」", async () => {
    const shipments = [
      shipment({ id: "r1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "r2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const filtered = await ask({ shipments, message: "我在途有多少单" });
    assert.ok(
      !filtered.answer.includes("已完成：0 单"),
      `还在打那个会让人误会的 0：\n${filtered.answer}`,
    );
    assert.equal(totalCountOf(filtered.answer), 2);
    // 「全部运单」时分项是真实的，必须照旧打出来
    const all = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(all.answer.includes("在途中："), `全部范围下的分项被误删了：\n${all.answer}`);
    assert.ok(all.answer.includes("已完成："), `全部范围下的分项被误删了：\n${all.answer}`);
  });

  await check("17) 模型编一个单号，抢不走统计分支", async () => {
    const shipments = [
      shipment({ id: "s1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我这个月一共发了多少货？",
      // 模型在 trackingNo 里瞎填一个问句里根本没有的单号
      intent: JSON.stringify({ intent: "tracking", trackingNo: "THCN9999" }),
    });
    assert.ok(!answer.includes("未找到运单号"), `被模型编的单号带偏了：\n${answer}`);
    assert.ok(answer.includes("查询范围："), `没走统计分支：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("18) 客户写「TH-CN 0001」时，模型归一化出来的单号仍然采信", async () => {
    const target = shipment({ id: "t1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs });
    const { answer } = await ask({
      shipments: [{ ...target, trackingNo: "THCN0001" } as Shipment],
      message: "我的单号 TH-CN 0001 到哪了",
      intent: JSON.stringify({ intent: "tracking", trackingNo: "THCN0001" }),
    });
    assert.ok(answer.includes("THCN0001"), `没认出这个单号：\n${answer}`);
    assert.ok(!answer.includes("未找到运单号"), `认成查无此单了：\n${answer}`);
  });

  await check("19) 发给模型的上下文里不再塞整份运单 id 列表", async () => {
    const shipments = Array.from({ length: 50 }, (_, i) =>
      shipment({ id: `u${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { contexts } = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(contexts.length >= 1, "没抓到发给模型的上下文");
    for (const context of contexts) {
      assert.ok(!context.includes("evidenceShipmentIds"), `上下文里还有整份运单 id：\n${context}`);
      assert.ok(!context.includes("evidenceOrderIds"), `上下文里还有整份订单 id：\n${context}`);
      assert.ok(!context.includes("s_u49"), "上下文里出现了具体的运单 id");
    }
    const longest = Math.max(...contexts.map((c) => c.length));
    assert.ok(longest < 4000, `上下文还是太长了：${longest} 字符`);
  });

  await check("20) 「我一共有多少单」这类问法不会被当成品名", async () => {
    // 抓品名的正则会把「我一共有」整个抓进去。中文没有词边界，
    // 光靠黑名单堵不住，得把开头的人称/副词和结尾的动词剥掉。
    orderNames.set("v1", { itemName: "共享单车配件", productNames: ["共享单车配件"] });
    orderNames.set("v2", { itemName: "有机玻璃", productNames: ["有机玻璃"] });
    const shipments = [
      shipment({ id: "v1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "v2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    for (const message of ["我一共有多少单", "我一共发了多少单", "我总共有多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名了：\n${answer}`);
      assert.equal(totalCountOf(answer), 2, `「${message}」算错了：\n${answer}`);
    }
    // 反过来：剥词不能把真品名剥坏（"共享…"不能剥成"享…"，"有机玻璃"不能剥掉"有"）
    for (const [message, expected] of [
      ["共享单车配件有多少单", "品名：共享单车配件"],
      ["有机玻璃有多少单", "品名：有机玻璃"],
      ["我的有机玻璃有多少单", "品名：有机玻璃"],
    ] as Array<[string, string]>) {
      const { answer } = await ask({ shipments, message });
      assert.ok(answer.includes(expected), `「${message}」认错品名：\n${answer}`);
    }
  });

  // ── 21~27. 2026-08-28 复核（Codex）报出来、我核实属实的几条 ────────────────
  await check("21) 数字调包：10 单 / 3 千克 被换成 3 单 / 10 千克 要拦住", async () => {
    // 只比「数字集合」的话这里两边一模一样 {10,3}，会放行 —— 必须连单位一起比
    const shipments = Array.from({ length: 10 }, (_, i) =>
      shipment({ id: `w${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, weightKg: 0.3 }),
    );
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/总单量：10 单/, "总单量：3 单"], [/3\.00 千克/, "10.00 千克"]),
    });
    assert.ok(answer.includes("总单量：10 单"), `数字被调包了还发出去：\n${answer}`);
    assert.ok(answer.includes("3.00 千克"), `重量被调包了还发出去：\n${answer}`);
  });

  await check("22) 单位调包：重量的数字挪到体积上要拦住", async () => {
    const shipments = [
      shipment({
        id: "x1",
        createdAtMs: nowMs - 86400_000,
        updatedAtMs: nowMs,
        weightKg: 5,
        volumeM3: 2,
      }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/5\.00 千克/, "5.00 立方米"]),
    });
    assert.ok(answer.includes("5.00 千克"), `重量被说成体积了还发出去：\n${answer}`);
  });

  await check("23) 正负号：3 单被写成 -3 单要拦住", async () => {
    const shipments = Array.from({ length: 3 }, (_, i) =>
      shipment({ id: `y${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/总单量：3 单/, "总单量：-3 单"]),
    });
    assert.ok(!answer.includes("-3 单"), `负号被放行了：\n${answer}`);
  });

  await check("24) 分柜子单号不再被截成父单号", async () => {
    const parent = shipment({
      id: "z_p",
      createdAtMs: nowMs - 86400_000,
      updatedAtMs: nowMs,
      trackingNo: "SZ260801388",
      status: "loaded",
    });
    const child = shipment({
      id: "z_c",
      createdAtMs: nowMs - 3600_000,
      updatedAtMs: nowMs,
      orderId: parent.orderId,
      trackingNo: "SZ260801388-2",
      parentTrackingNo: "SZ260801388",
      status: "arrivedPort",
    });
    const { answer } = await ask({
      shipments: [parent, child],
      message: "我的单号 SZ260801388-2 到哪了",
    });
    assert.ok(answer.includes("SZ260801388-2"), `子单号被截成父单号了：\n${answer}`);
    assert.ok(answer.includes("arrivedPort"), `回的是父单的状态：\n${answer}`);
  });

  await check("25) 模型返回的时间/状态盖不过问句里明确说的", async () => {
    const shipments = [
      shipment({
        id: "aa1",
        createdAtMs: beijingMonthStartMs() + 1000,
        updatedAtMs: nowMs,
        status: "loaded",
      }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我这个月在途有多少单",
      // 模型胡说成「今天、已完成」
      intent: JSON.stringify({ intent: "summary", timeHint: "今天", statusScope: "completed" }),
    });
    assert.ok(answer.includes("查询范围：本月，在途运单"), `被模型带偏了：\n${answer}`);
  });

  await check("26) 模型返回的品名盖不过问句里明确说的", async () => {
    orderNames.set("bb1", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("bb2", { itemName: "手机壳", productNames: ["手机壳"] });
    const shipments = [
      shipment({ id: "bb1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "bb2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "耳机订单有多少单？",
      intent: JSON.stringify({ intent: "summary", itemName: "手机壳" }),
    });
    assert.ok(answer.includes("品名：耳机"), `被模型换成手机壳了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("27) 剥词不碰模型返回的真实品名", async () => {
    // 品名真的就叫「我的美妆」，剥词会把它剥成「美妆」→ 统计范围就错了
    orderNames.set("cc1", { itemName: "我的美妆", productNames: ["我的美妆"] });
    orderNames.set("cc2", { itemName: "美妆刷", productNames: ["美妆刷"] });
    const shipments = [
      shipment({ id: "cc1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "cc2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "帮我看看这个品类",
      intent: JSON.stringify({ intent: "summary", itemName: "我的美妆" }),
    });
    assert.ok(answer.includes("品名：我的美妆"), `品名被剥坏了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `剥成「美妆」后把美妆刷也算进来了：\n${answer}`);
  });

  await check("28) 历史分柜父单挂着整票量时不重复统计", async () => {
    // 老数据：父单没被扣减，父子加起来是整票的两倍。订单合计才是真的。
    orderTotals.set("dd", { weightKg: 100, volumeM3: 1 });
    const parent = shipment({
      id: "dd_p",
      createdAtMs: nowMs - 86400_000,
      updatedAtMs: nowMs,
      orderId: "o_dd",
      trackingNo: "THDD",
      weightKg: 100,
      volumeM3: 1,
    });
    const child = shipment({
      id: "dd_c",
      createdAtMs: nowMs - 3600_000,
      updatedAtMs: nowMs,
      orderId: "o_dd",
      trackingNo: "THDD-2",
      parentTrackingNo: "THDD",
      weightKg: 100,
      volumeM3: 1,
    });
    const { answer } = await ask({ shipments: [parent, child], message: "我一共有多少单" });
    assert.ok(answer.includes("100.00 千克"), `重量被重复统计了：\n${answer}`);
    assert.ok(!answer.includes("200.00"), `重量被重复统计了：\n${answer}`);
  });

  await check("29) 没填重量体积时不显示 0.00，而是压根不打这一行", async () => {
    const shipments = [
      shipment({ id: "ee1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(!answer.includes("0.00 千克"), `空值被显示成 0 了：\n${answer}`);
    assert.ok(!answer.includes("0.000 立方米"), `空值被显示成 0 了：\n${answer}`);
    assert.ok(!answer.includes("总重量约"), `没数据还打了重量行：\n${answer}`);
  });

  await check("30) 缺父单的家族取最早的下单时间，不取分柜时间", async () => {
    // 只有子单、没有父单行的历史家族：不能拿分柜时间当下单时间
    const oldCreated = nowMs - 200 * 86400_000;
    const rows = [
      shipment({
        id: "ff_new",
        createdAtMs: beijingMonthStartMs() + 1000,
        updatedAtMs: nowMs,
        orderId: "o_ff",
        trackingNo: "THFF-2",
        parentTrackingNo: "THFF",
      }),
      shipment({
        id: "ff_old",
        createdAtMs: oldCreated,
        updatedAtMs: nowMs,
        orderId: "o_ff",
        trackingNo: "THFF-1",
        parentTrackingNo: "THFF",
      }),
    ];
    const { answer } = await ask({ shipments: rows, message: "我这个月一共发了多少货？" });
    assert.equal(totalCountOf(answer), 0, `半年前的老单被算进本月了：\n${answer}`);
  });

  await check("31) 品名带空格或全角字符时不会退回「全部品类」", async () => {
    // 退回全部品类 = 客户问一个品名，系统把他全部的单都报给他
    for (const [id, name] of [
      ["gg1", "ABC DEF"],
      ["gg2", "ＡＢＣ１２３"],
    ] as Array<[string, string]>) {
      orderNames.set(id, { itemName: name, productNames: [name] });
    }
    orderNames.set("gg3", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["gg1", "gg2", "gg3"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    for (const name of ["ABC DEF", "ＡＢＣ１２３"]) {
      const { answer } = await ask({
        shipments,
        message: "帮我看看这个品类",
        intent: JSON.stringify({ intent: "summary", itemName: name }),
      });
      assert.ok(answer.includes(`品名：${name}`), `品名「${name}」被丢掉了：\n${answer}`);
      assert.equal(totalCountOf(answer), 1, `品名「${name}」退回了全部品类：\n${answer}`);
    }
  });

  await check("32) 品名里含「运输」「完成」这类词时不会退回「全部品类」", async () => {
    orderNames.set("hh1", { itemName: "运输箱", productNames: ["运输箱"] });
    orderNames.set("hh2", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["hh1", "hh2"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { answer } = await ask({
      shipments,
      message: "帮我看看这个品类",
      intent: JSON.stringify({ intent: "summary", itemName: "运输箱" }),
    });
    assert.ok(answer.includes("品名：运输箱"), `真品名被词表拒掉了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `退回了全部品类：\n${answer}`);
  });

  await check("33) 但整句问话仍然拦得住（词表只是不再误伤真品名）", async () => {
    orderNames.set("ii1", { itemName: "运输箱", productNames: ["运输箱"] });
    const shipments = [shipment({ id: "ii1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我在途有多少单" });
    assert.ok(answer.includes("全部品类"), `整句问话被当成品名了：\n${answer}`);
  });

  // ══ P1-1 复核抓到的绕过（2026-08-28）══════════════════════════════════
  // 旧闸用「数字集合」比较，看不出顺序和归属，下面这些全被放行过。
  // 正确做法是让模型从头到尾看不到真实数字（占位符方案）。

  await check("34) 同单位两个数字互换 → 必须拦住", async () => {
    // ⚠️ 三个数必须**互不相同**，否则互换等于没换，测试会假绿
    const shipments = [
      shipment({ id: "p1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    // ⚠️ 记号 0 是开头「查到 N 单」那句，1 才是「总单量」——
    // 换 0/1 时两处都是同一个数，等于没换，测试会假绿（第一版就踩了这个）
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: swapTokens(1, 2) });
    assert.equal(totalCountOf(answer), 3, `数字被互换后仍发给了客户：\n${answer}`);
  });

  await check("35) 数字换成中文（三单）→ 必须拦住", async () => {
    const shipments = [shipment({ id: "q1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "三单") });
    assert.ok(!answer.includes("三单"), `模型写的中文数字发给了客户：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("36) Unicode 负号（−3 单）→ 必须拦住", async () => {
    const shipments = [shipment({ id: "r1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "\u22123 单") });
    assert.ok(!answer.includes("\u2212"), `Unicode 负号发给了客户：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("37) 去掉单位后再交换 → 必须拦住", async () => {
    // 两个数字都是草稿里本来就有的，只是位置对调、单位去掉 ——
    // 旧闸「数字集合」和「数字单位对」两关都查不出来
    const shipments = [
      shipment({ id: "s1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "s2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "s3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: (draft) => {
        const hits = draft.match(TOKEN_RE) ?? [];
        assert.ok(hits.length >= 2, `草稿里数据记号不够：\n${draft}`);
        const bare = (t: string) => t.replace(/\s*(?:单|票|张|件|箱|千克|公斤|kg|立方米|立方|方|m³)$/, "");
        let i = -1;
        return draft.replace(TOKEN_RE, (m) => {
          i += 1;
          if (i === 1) return bare(hits[2]!);
          if (i === 2) return bare(hits[1]!);
          return m;
        });
      },
    });
    assert.equal(totalCountOf(answer), 3, `去掉单位的交换被放行了：\n${answer}`);
  });

  await check("38) 模型吞掉一处数据 → 必须拦住", async () => {
    const shipments = [shipment({ id: "t1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "若干") });
    assert.ok(!answer.includes("若干"), `模型把数据吞成「若干」还发出去了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("39) 正常措辞的润色仍然要放行（别误杀）", async () => {
    const shipments = [shipment({ id: "u1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      // 「一共」「十分」里带中文数字字样，但不是数量词，不能被拦
      polish: (draft) => `亲，一共帮你查好了，十分感谢等待。\n${draft}`,
    });
    assert.ok(answer.includes("十分感谢等待"), `正常润色被误杀了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length}/39 项不通过（TZ=${TZ_LABEL}）：${failures.join("；")}`);
  }
  console.log(`AI 答复数字校验：39 项全部通过（TZ=${TZ_LABEL}）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
