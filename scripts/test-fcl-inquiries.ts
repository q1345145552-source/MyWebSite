/**
 * 整柜询价列表分页参数的自测（2026-09-01 Codex 复核收尾）。
 *
 * 为什么要有：复核指出列表的 page 参数只用 parseInt 卡了最小值，
 * 传 `1e400` 这类怪值会算出 Infinity 的 skip，Prisma 直接 500。
 * 修法是严格校验（parseNumericStrict + Number.isSafeInteger），
 * 这个脚本盯着「非法参数在**碰库之前**就被 400 拦住」这件事。
 *
 * ⚠️ 全程**不连数据库**（照 test-client-address-update.ts 的夹具写法）：
 * apps/api/src/db/prisma.ts 是 `globalThis.__prisma ?? new PrismaClient()`，
 * 在 import 之前把 __prisma 换成假的，PrismaClient 根本不会被 new 出来。
 * 下面那行被挡死的 DATABASE_URL 是第二道保险 —— 万一哪天这条路上
 * 多了一次真库调用，会当场炸出来而不是悄悄连上测试库。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

type Handler = (req: any, res: any) => Promise<void> | void;

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/** 假库：把 count/findMany 的参数录下来供断言；返回空结果，绝不真连库 */
let countCalls: any[] = [];
let findManyCalls: any[] = [];
(globalThis as any).__prisma = {
  fclInquiry: {
    async count(args: unknown) { countCalls.push(args); return 0; },
    async findMany(args: unknown) { findManyCalls.push(args); return []; },
  },
};

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const mod = await import("../apps/api/src/modules/fcl-inquiries/routes");
  (mod as any).registerFclInquiryRoutes(fakeApp);

  const handler = routes.get("GET /client/fcl-inquiries");
  assert.ok(handler, "没注册到 GET /client/fcl-inquiries");

  async function call(query: Record<string, string>, role = "client"): Promise<{ status: number; message: string; data: any }> {
    countCalls = [];
    findManyCalls = [];
    let status = 0;
    let payload: { message?: string; data?: unknown } = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v as typeof payload; } };
    await handler!({
      method: "GET", path: "", query, headers: {}, body: undefined,
      auth: { userId: "CLIENT1", companyId: "c_001", role, name: "测试客户" },
    }, res);
    return { status, message: payload.message ?? "", data: payload.data };
  }

  console.log("整柜询价列表分页参数");

  await check("1) page=1e400 必须 400「页码不合法」，而且没碰库", async () => {
    /**
     * 原 bug 现场：parseInt("1e400") 虽然只认到 1，但只要哪天有人把它
     * 换回 Number(...) 就是 Infinity → skip=Infinity → Prisma 500。
     * 现在的规矩：不是安全整数一律 400，根本走不到查库那一步。
     */
    const r = await call({ page: "1e400" });
    assert.equal(r.status, 400, `应该 400，实际 ${r.status}`);
    assert.equal(r.message, "页码不合法", `提示语不对：${JSON.stringify(r.message)}`);
    assert.equal(countCalls.length + findManyCalls.length, 0, "参数非法还是去查库了");
  });

  await check("2) page=0 / page=-1 / page=2.5 / page=abc 一律 400，都没碰库", async () => {
    for (const bad of ["0", "-1", "2.5", "abc", "Infinity", "NaN", "9007199254740993"]) {
      const r = await call({ page: bad });
      assert.equal(r.status, 400, `page=${bad}：应该 400，实际 ${r.status}`);
      assert.equal(r.message, "页码不合法", `page=${bad}：提示语不对：${JSON.stringify(r.message)}`);
      assert.equal(countCalls.length + findManyCalls.length, 0, `page=${bad}：参数非法还是去查库了`);
    }
  });

  await check("3) pageSize 非法（0 / -5 / 1.5 / abc）也 400，没碰库", async () => {
    for (const bad of ["0", "-5", "1.5", "abc", "1e400"]) {
      const r = await call({ pageSize: bad });
      assert.equal(r.status, 400, `pageSize=${bad}：应该 400，实际 ${r.status}`);
      assert.equal(r.message, "每页条数不合法", `pageSize=${bad}：提示语不对：${JSON.stringify(r.message)}`);
      assert.equal(countCalls.length + findManyCalls.length, 0, `pageSize=${bad}：参数非法还是去查库了`);
    }
  });

  await check("4) pageSize=999 被夹到 200 —— 传再大也只给 200", async () => {
    const r = await call({ page: "1", pageSize: "999" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}（${r.message}）`);
    assert.equal(findManyCalls[0]?.take, 200, `take 没被夹到 200：${findManyCalls[0]?.take}`);
    assert.equal(r.data?.pageSize, 200, `响应里的 pageSize 该是 200：${r.data?.pageSize}`);
  });

  await check("5) 正常 page=1 走到查库前不报参数错，skip/take 都对", async () => {
    const r = await call({ page: "1", pageSize: "50" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}（${r.message}）`);
    assert.equal(findManyCalls[0]?.skip, 0, `skip 该是 0：${findManyCalls[0]?.skip}`);
    assert.equal(findManyCalls[0]?.take, 50, `take 该是 50：${findManyCalls[0]?.take}`);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.total, 0);
  });

  await check("6) 不传 page/pageSize 用默认值 1/50（前端老调用不受影响）", async () => {
    const r = await call({});
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}（${r.message}）`);
    assert.equal(findManyCalls[0]?.skip, 0, `skip 该是 0：${findManyCalls[0]?.skip}`);
    assert.equal(findManyCalls[0]?.take, 50, `take 该是 50：${findManyCalls[0]?.take}`);
    assert.equal(r.data?.page, 1);
    assert.equal(r.data?.pageSize, 50);
  });

  await check("7) skip 有第二道保险：page 很大也绝不给 Prisma 超界数", async () => {
    // 9007199254740991 = Number.MAX_SAFE_INTEGER，是合法的安全整数，能过校验；
    // (page-1)*pageSize 会溢出安全整数范围，靠 clamp 兜住。
    const r = await call({ page: "9007199254740991", pageSize: "200" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}（${r.message}）`);
    const skip = findManyCalls[0]?.skip;
    assert.ok(Number.isSafeInteger(skip), `skip 不是安全整数：${skip} —— Prisma 会 500`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/7 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("整柜询价列表分页参数：7 项全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
