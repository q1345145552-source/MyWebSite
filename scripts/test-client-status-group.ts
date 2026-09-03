/**
 * 客户端订单分组（statusGroup）口径自测（2026-09-03 老板当天二次拍板后补）。
 *
 * 为什么要有：这个口径 2026-09-03 一天之内改了两次
 *   ① 早上：到仓后整段从「在途」拆出来 → arrived
 *   ② 下午：老板重新定边界 —— 「正在卸柜」算**在途**（柜子还在卸、货没进仓），
 *      「已到仓」= 进泰国仓到客户签收之前的整段（含预约派送、尾端派送中），
 *      派送不单独分格，签收了才跳「已签收」。
 * 改一次没测试，下次再改（或有人手滑把 unloading 加回 arrived）没人拦得住。
 *
 * 盯三件事：
 *   1. 31 个真实状态逐个映射对（真调 GET /client/orders 路由，看响应里的 statusGroup，
 *      不是 grep 源码 —— 把分类函数包进 if(false) 这个测试会红）
 *   2. statusGroup= 筛选参数真的只放对应分组的单过（含老页面缓存发的 unfinished/completed）
 *   3. ⭐ 全覆盖闸：直接 import 海运/陆运状态流，凡是流程里出现过的状态
 *      都必须在本文件的期望表里有一行 —— 以后加状态忘了归类，这里当场红
 *
 * ⚠️ 全程不连数据库（照 test-fcl-inquiries.ts 的夹具写法）：import 之前把
 * globalThis.__prisma 换成假的，PrismaClient 根本不会被 new 出来。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { STATUS_FLOW, STATUS_FLOW_LAND, EXCEPTION_STATUSES } from "../apps/api/src/modules/shipments/status-flow";

type Handler = (req: any, res: any) => Promise<void> | void;
type Group = "pending" | "transit" | "arrived" | "delivered" | "closed";

const failures: string[] = [];
let totalChecks = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  totalChecks += 1;
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/* ── 期望表：状态 → 应该落进哪个按钮。这张表就是老板拍的口径，改口径先改这里 ── */
const EXPECT: Record<string, Group> = {
  // 未发出：货还在国内仓
  created: "pending", inWarehouseCN: "pending", holdLoading: "pending",

  // 在途：从国内仓发出，到进泰国仓之前（含「正在卸柜」）
  loaded: "transit", customsInspectCn: "transit", inspectClearedCn: "transit",
  exportCleared: "transit", customsTH: "transit", customsCleared: "transit",
  delayDeparted: "transit", etaUpdated: "transit", portClosed: "transit",
  berthed: "transit", departed: "transit", delayInTransit: "transit",
  arrivedPort: "transit", customsInspectTh: "transit", inspectClearedTh: "transit",
  atPortCn: "transit", borderDelay: "transit", inVietnam: "transit",
  customsInspect: "transit", laosCleared: "transit",
  // ⭐ 2026-09-03 老板拍板：柜子还在卸、货还没进仓，算在途。别挪走。
  unloading: "transit",

  // 已到仓：进了泰国仓之后、客户签收之前的整段（派送不单独分格）
  inWarehouseTH: "arrived", deliveryBooked: "arrived", outForDelivery: "arrived",

  // 已签收 / 退回取消异常
  delivered: "delivered",
  exception: "closed", returned: "closed", cancelled: "closed",
};

let orderRows: any[] = [];
(globalThis as any).__prisma = {
  order: {
    async count() { return orderRows.length; },
    async findMany() { return orderRows; },
  },
  // 下面几个都不该影响分组，返回空即可（真被调到也不炸）
  shipment: { async findMany() { return []; } },
  orderProductImage: { async findMany() { return []; } },
  orderProduct: { async findMany() { return []; } },
};

function fakeOrder(id: string, currentStatus: string | null): any {
  return {
    id, clientId: "CLIENT1", warehouseId: "wh_yiwu_01", receiverAddressTh: "曼谷",
    orderNo: `NO-${id}`, itemName: "[测试] 货", transportMode: "sea",
    domesticTrackingNo: null, approvalStatus: "approved",
    productQuantity: 1, packageCount: 1, packageUnit: "box",
    weightKg: null, volumeM3: null, receivableAmountCny: null,
    receivableCurrency: "CNY", paymentStatus: "unpaid", paidAt: null, paidBy: null,
    shipDate: null, cargoType: "normal",
    createdAt: new Date(0), updatedAt: new Date(0),
    shipments: currentStatus === null
      ? []
      : [{ id: `s_${id}`, trackingNo: `T-${id}`, currentStatus, remark: null, statusLogs: [] }],
  };
}

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    put(p: string, h: Handler) { routes.set(`PUT ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const mod = await import("../apps/api/src/modules/orders/routes");
  (mod as any).registerOrderRoutes(fakeApp);

  const handler = routes.get("GET /client/orders");
  assert.ok(handler, "没注册到 GET /client/orders");

  async function call(query: Record<string, string> = {}): Promise<{ status: number; items: any[] }> {
    let status = 0;
    let payload: { data?: any } = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v as typeof payload; } };
    await handler!({
      method: "GET", path: "", query, headers: {}, body: undefined,
      auth: { userId: "CLIENT1", companyId: "c_001", role: "client", name: "测试客户" },
    }, res);
    return { status, items: payload.data?.items ?? [] };
  }

  const ALL = Object.keys(EXPECT);
  console.log("客户端订单分组口径（statusGroup）");

  await check(`1) ${ALL.length} 个状态逐个映射对（真走路由，看响应里的 statusGroup）`, async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const r = await call();
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}`);
    assert.equal(r.items.length, ALL.length, `不传分组应该全returned，实际 ${r.items.length}`);
    const wrong: string[] = [];
    r.items.forEach((item: any, i: number) => {
      if (item.statusGroup !== EXPECT[ALL[i]]) {
        wrong.push(`${ALL[i]}：期望 ${EXPECT[ALL[i]]}，实际 ${item.statusGroup}`);
      }
    });
    assert.equal(wrong.length, 0, `分错了 ${wrong.length} 个：\n${wrong.join("\n")}`);
  });

  await check("2) ⭐「正在卸柜」必须算在途 —— 老板 09-03 拍板，别挪回已到仓", async () => {
    orderRows = [fakeOrder("u1", "unloading")];
    const r = await call();
    assert.equal(r.items[0]?.statusGroup, "transit", `unloading 该是 transit，实际 ${r.items[0]?.statusGroup}`);
    // 反向再确认一次：点「已到仓」按钮时它不许出现
    orderRows = [fakeOrder("u1", "unloading")];
    const arrivedOnly = await call({ statusGroup: "arrived" });
    assert.equal(arrivedOnly.items.length, 0, "点「已到仓」不该查出正在卸柜的单");
  });

  await check("3)「已到仓」= 已到仓 + 预约派送 + 派送中（派送不单独分格，签收了才走）", async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const r = await call({ statusGroup: "arrived" });
    const got = r.items.map((x: any) => x.currentStatus).sort();
    assert.deepEqual(got, ["deliveryBooked", "inWarehouseTH", "outForDelivery"].sort(),
      `「已到仓」查出来的状态不对：${JSON.stringify(got)}`);
  });

  await check("4) 五个分组的筛选参数各自只放对的单过，加起来不多不少", async () => {
    let sum = 0;
    for (const group of ["pending", "transit", "arrived", "delivered", "closed"] as Group[]) {
      orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
      const r = await call({ statusGroup: group });
      const expected = ALL.filter((s) => EXPECT[s] === group);
      const got = r.items.map((x: any) => x.currentStatus).sort();
      assert.deepEqual(got, [...expected].sort(), `${group} 查出来的不对：${JSON.stringify(got)}`);
      const bad = r.items.find((x: any) => x.statusGroup !== group);
      assert.ok(!bad, `${group} 里混进了 ${bad?.currentStatus}（${bad?.statusGroup}）`);
      sum += r.items.length;
    }
    assert.equal(sum, ALL.length, `五个分组加起来 ${sum}，应该正好 ${ALL.length} 张，有单丢了或重了`);
  });

  await check("5) 老页面缓存发的 unfinished / completed 还认（unfinished 含已到仓）", async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const un = await call({ statusGroup: "unfinished" });
    const unExpect = ALL.filter((s) => ["pending", "transit", "arrived"].includes(EXPECT[s]));
    assert.deepEqual(un.items.map((x: any) => x.currentStatus).sort(), [...unExpect].sort(),
      "unfinished 应该 = 未发出 + 在途 + 已到仓");
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const done = await call({ statusGroup: "completed" });
    const doneExpect = ALL.filter((s) => ["delivered", "closed"].includes(EXPECT[s]));
    assert.deepEqual(done.items.map((x: any) => x.currentStatus).sort(), [...doneExpect].sort(),
      "completed 应该 = 已签收 + 退回取消异常");
  });

  await check("6) 没运单 / 状态为空的老数据归「未发出」，不许漏出别的格", async () => {
    orderRows = [fakeOrder("n1", null), fakeOrder("n2", "")];
    const r = await call();
    assert.deepEqual(r.items.map((x: any) => x.statusGroup), ["pending", "pending"],
      "没运单和空状态都该是 pending");
  });

  await check("7) 不认识的状态兜底进「在途」，绝不凭空消失", async () => {
    orderRows = [fakeOrder("x1", "someNewStatusNobodyClassified")];
    const all = await call();
    assert.equal(all.items[0]?.statusGroup, "transit", "陌生状态该兜底进 transit");
    orderRows = [fakeOrder("x1", "someNewStatusNobodyClassified")];
    const un = await call({ statusGroup: "unfinished" });
    assert.equal(un.items.length, 1, "陌生状态在 unfinished 里也要看得到，不能整单消失");
  });

  await check("8) ⭐ 全覆盖闸：海运/陆运流程 + 异常态里每个状态都在期望表里", async () => {
    const inFlow = new Set<string>([...STATUS_FLOW, ...STATUS_FLOW_LAND, ...EXCEPTION_STATUSES]);
    const missing = [...inFlow].filter((s) => !(s in EXPECT));
    assert.equal(missing.length, 0,
      `这些状态在流程里有、但本测试的期望表没归类（新加状态要来这里补一行，并确认老板要它落哪个按钮）：${missing.join(", ")}`);
    // 反向：期望表里不许有流程里根本不存在的状态（防止照着旧文档抄错状态名）
    const ghost = ALL.filter((s) => !inFlow.has(s));
    assert.equal(ghost.length, 0, `期望表里这些状态在两条流程里都不存在，可能拼错了：${ghost.join(", ")}`);
  });

  console.log(`\n共 ${totalChecks} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log("✅ 全部通过");
}

main().catch((error) => { console.error(error); process.exit(1); });
