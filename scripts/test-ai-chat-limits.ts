/**
 * AI 聊天接口的三道闸自测（不连数据库、不连 DeepSeek）。
 *
 * 为什么要有这个：`/client/ai/chat` 是全系统唯一直接花钱的接口 ——
 * 每条消息固定调两次 DeepSeek。上线以来它一次限流都没有，消息长度也不校验。
 * ⚠️ 这个脚本**一次都不能走到 service.chat**：那里会连数据库、并调两次 DeepSeek。
 * 做法是让每个请求都在某一道闸前面被拦下 —— 三道闸的先后顺序是
 * 【限流 → 消息长度 → sessionId 长度 → service.chat】，
 * 所以「要验证某一道闸放行了」就故意让它撞下一道闸，用下一道闸的报错反证前一道放行了。
 * 初版没这么写，结果真跑去连了 Neon 测试库（还触发了 ai_session_memory 的过期清理）。
 */
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../apps/api/src/server";
import { registerClientAiRoutes } from "../apps/api/src/modules/ai/client-ai-routes";

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

const routes = new Map<string, Handler>();
const fakeApp: MinimalHttpApp = {
  get(path, handler) {
    routes.set(`GET ${path}`, handler);
  },
  post(path, handler) {
    routes.set(`POST ${path}`, handler);
  },
  delete(path, handler) {
    routes.set(`DELETE ${path}`, handler);
  },
  listen() {},
};
registerClientAiRoutes(fakeApp);

const chat = routes.get("POST /client/ai/chat");
assert.ok(chat, "没注册 /client/ai/chat 路由");

/** 每个用例用不同的 userId，避免共用同一个限流计数桶 */
function auth(userId: string): NonNullable<HttpRequest["auth"]> {
  return { userId, companyId: "c_1", role: "client", name: "测试客户" };
}

async function call(userId: string, body: unknown) {
  let status = 0;
  let payload: { code?: string; message?: string } = {};
  const res: HttpResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value as { code?: string; message?: string };
    },
  };
  await chat!(
    { method: "POST", path: "/client/ai/chat", query: {}, headers: {}, body, auth: auth(userId) },
    res,
  );
  // 三道闸只会回 400/429。出现别的（500 或 200）就说明请求穿过去了、
  // 真的去连库调模型了 —— 这正是初版脚本踩的坑，必须当场炸出来。
  if (status !== 400 && status !== 429) reachedService = true;
  return { status, message: payload.message ?? "" };
}

let reachedService = false;
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
  console.log("AI 聊天接口限流与长度校验");

  // 用超长消息当"探针"：它一定会被第二道闸（长度）拦成 400。
  // 于是收到 400 = 限流放行了，收到 429 = 被限流了。全程走不到 service.chat。
  const tooLong = { message: "货".repeat(501) };

  await check("1) 每分钟前 10 条放行、第 11 条被限流（429）", async () => {
    const userId = "u_rate_1";
    for (let i = 1; i <= 10; i += 1) {
      const result = await call(userId, tooLong);
      assert.equal(result.status, 400, `第 ${i} 条就被限流了，太早（拿到 ${result.status}）`);
    }
    const eleventh = await call(userId, tooLong);
    assert.equal(eleventh.status, 429, "第 11 条没有被限流");
    assert.ok(eleventh.message.includes("每分钟最多 10 条"), `提示语不对：${eleventh.message}`);
  });

  await check("2) 限流按账号算，换个账号不受上一个账号连累", async () => {
    const other = await call("u_rate_2", tooLong);
    assert.equal(other.status, 400, "另一个账号被上一个账号的计数连累了");
  });

  await check("3) 超过 500 字直接拒，不往下走（不花钱）", async () => {
    const result = await call("u_len_1", tooLong);
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("500 个字"), `提示语不对：${result.message}`);
  });

  await check("4) 正好 500 字不算超长（边界不能误伤）", async () => {
    // 同样用"探针"手法：配一个超长 sessionId，让它被第三道闸拦下。
    // 拿到「会话标识」的报错 = 500 字这一关放行了；拿到「500 个字」= 边界写错了。
    const result = await call("u_len_2", {
      message: "货".repeat(500),
      sessionId: "s".repeat(101),
    });
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("会话标识"), `500 字被长度闸误拦了：${result.message}`);
  });

  await check("5) 超长 sessionId 被拒（它会被当成 key 写进会话记忆表）", async () => {
    const result = await call("u_sess_1", { message: "你好", sessionId: "s".repeat(101) });
    assert.equal(result.status, 400);
    assert.ok(result.message.includes("会话标识"), `提示语不对：${result.message}`);
  });

  await check("6) 全程没有走到 service.chat（没连库、没调 DeepSeek）", async () => {
    assert.equal(
      reachedService,
      false,
      "有请求穿过了三道闸走进业务逻辑 —— 这个脚本不该连数据库",
    );
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length}/6 项不通过：${failures.join("；")}`);
  }
  console.log("AI 聊天接口限流：6 项全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
