/**
 * 接口响应格式的自测（不连数据库、不起真服务器）。
 *
 * 为什么要有这个：2026-08-28 复核指出，全局异常处理直接
 * `res.json({ code, message })` 自己拼响应体，少了契约
 * （docs/api-contract.md 第 2、3 节）要求的 `errors` / `requestId` / `timestamp` ——
 * 同一个系统里两种错误格式，前端要写两套解析，客户报错也没有编号可查。
 *
 * 这个脚本盯两件事：
 *   ① ok() / fail() 拼出来的字段跟契约一致；
 *   ② **没有别的地方再自己拼响应体** —— 靠扫源码，不靠人记得。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ok, fail } from "../apps/api/src/modules/core/http-utils";
import { createJsonResponse, type HttpResponse } from "../apps/api/src/server";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

function fakeRes(requestId?: string): HttpResponse & { sent?: Record<string, unknown>; code?: number } {
  const res: HttpResponse & { sent?: Record<string, unknown>; code?: number } = {
    requestId,
    status(code: number) {
      res.code = code;
      return res;
    },
    json(payload: unknown) {
      res.sent = payload as Record<string, unknown>;
    },
  };
  return res;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

console.log("接口响应格式");

check("1) 成功响应带齐契约要求的字段", () => {
  const res = fakeRes("req_test_ok");
  ok(res, { hello: "world" });
  assert.equal(res.code, 200, "状态码不对");
  const body = res.sent!;
  assert.equal(body.code, "OK");
  assert.equal(body.message, "success");
  assert.deepEqual(body.data, { hello: "world" });
  assert.equal(body.requestId, "req_test_ok", "requestId 没带上");
  assert.ok(ISO.test(String(body.timestamp)), `timestamp 不是 ISO 8601：${body.timestamp}`);
});

check("2) 失败响应带齐契约要求的字段", () => {
  const res = fakeRes("req_test_fail");
  fail(res, 403, "FORBIDDEN", "没权限");
  assert.equal(res.code, 403, "状态码不对");
  const body = res.sent!;
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(body.message, "没权限");
  assert.deepEqual(body.errors, [{ reason: "没权限" }], "errors 不对");
  assert.equal(body.requestId, "req_test_fail", "requestId 没带上");
  assert.ok(ISO.test(String(body.timestamp)), `timestamp 不是 ISO 8601：${body.timestamp}`);
});

check("3) 没有 requestId 时也不能崩（老的测试桩不带这个字段）", () => {
  const res = fakeRes(undefined);
  fail(res, 400, "BAD_REQUEST", "参数不对");
  assert.equal(res.sent!.code, "BAD_REQUEST");
  assert.equal(res.sent!.requestId, undefined, "没有编号时不该编一个出来");
});

/**
 * ⚠️ 上一版这一项是**正则扫源码**找 `.json({ code:`。
 * 复核实测能绕过：把业务错误写成
 *     const payload = { code, message };
 *     res.status(400).json(payload);
 * 4 项照样全绿 —— 正则认不出变量、helper 和 rawRes.end(JSON.stringify(...))。
 *
 * 所以改成**真的跑一遍**：拿真的 createJsonResponse 造一个响应对象，
 * 用各种写法往里塞响应体，看盖章有没有生效。
 * 现在盖章做在唯一出口 `json()` 上，怎么拼的都盖得到。
 */
function captureRealResponse(): {
  res: HttpResponse;
  read: () => { status: number; headers: Record<string, string>; body: Record<string, unknown> };
} {
  const headers: Record<string, string> = {};
  let ended = "";
  let status = 0;
  const rawRes = {
    set statusCode(v: number) { status = v; },
    get statusCode() { return status; },
    setHeader(k: string, v: string) { headers[k] = v; },
    end(chunk: string) { ended = chunk; },
  };
  const res = createJsonResponse(rawRes as never);
  return {
    res,
    read: () => ({ status, headers, body: JSON.parse(ended || "{}") as Record<string, unknown> }),
  };
}

check("4) 不管响应体怎么拼，出口都会盖上 requestId 和 timestamp", () => {
  // ① 走 ok()
  {
    const { res, read } = captureRealResponse();
    ok(res, { a: 1 });
    const { body, headers } = read();
    assert.ok(String(body.requestId).startsWith("req_"), `ok() 没盖章：${JSON.stringify(body)}`);
    assert.ok(ISO.test(String(body.timestamp)), "ok() 的 timestamp 不对");
    assert.equal(headers["X-Request-Id"], body.requestId, "响应头和响应体里的编号对不上");
  }
  // ② 走 fail()
  {
    const { res, read } = captureRealResponse();
    fail(res, 400, "BAD_REQUEST", "不行");
    const { body } = read();
    assert.ok(String(body.requestId).startsWith("req_"), "fail() 没盖章");
    assert.deepEqual(body.errors, [{ reason: "不行" }]);
  }
  // ③ 绕开 ok/fail 自己拼一个对象字面量（AI 那组 helper 就是这么干的）
  {
    const { res, read } = captureRealResponse();
    res.status(403).json({ code: "FORBIDDEN", message: "没权限" });
    const { body } = read();
    assert.ok(String(body.requestId).startsWith("req_"), `自己拼字面量时没盖上章：${JSON.stringify(body)}`);
    assert.ok(ISO.test(String(body.timestamp)), "自己拼字面量时没补 timestamp");
  }
  // ④ 复核那个绕过写法：先存进变量再发
  {
    const { res, read } = captureRealResponse();
    const payload = { code: "NOT_FOUND", message: "找不到" };
    res.status(404).json(payload);
    const { body } = read();
    assert.ok(
      String(body.requestId).startsWith("req_"),
      `先存变量再发就绕过去了（复核实测过的写法）：${JSON.stringify(body)}`,
    );
  }
  // ⑤ 不长得像契约响应体的东西别乱改（比如静态文件那种裸数据）
  {
    const { res, read } = captureRealResponse();
    res.status(200).json({ hello: "world" });
    const { body } = read();
    assert.deepEqual(body, { hello: "world" }, "不带 code 的响应体被动了");
  }
});

check("5) 已经带了编号的响应体不许被覆盖", () => {
  const { res, read } = captureRealResponse();
  res.status(200).json({ code: "OK", message: "s", requestId: "req_来自上游", timestamp: "2026-01-01T00:00:00.000Z" });
  const { body } = read();
  assert.equal(body.requestId, "req_来自上游", "把上游传下来的编号盖掉了");
  assert.equal(body.timestamp, "2026-01-01T00:00:00.000Z", "把已有的时间戳盖掉了");
});

check("6) 还有没有地方完全绕开 res.json 直接写响应（那种盖不到章）", () => {
  const apiRoot = path.join(__dirname, "..", "apps", "api", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
        /**
         * 绕开 res.json 直接往 socket 写 JSON 的，盖章盖不到，必须自己补齐字段。
         *
         * ⚠️ 2026-08-29 补 write / send：原来只认 `.end(JSON.stringify` ——
         * 独立变异把一处改成 `rawRes.write(JSON.stringify(...))`，
         * **6 项照样全绿**。同一件事换个方法名就漏掉了。
         */
        if (/\.(end|write|send)\(\s*JSON\.stringify/.test(line)) {
          offenders.push(`${path.relative(apiRoot, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(apiRoot);
  /**
   * ⚠️ 自检：扫描器必须至少认出 server.ts 那处已知的兜底。
   * 一处都没认出来，说明正则写窄了或者路径找错了 —— 那下面的绿灯不作数。
   * （这个脚本自己就在这上面栽过：只认 `.end(` 漏掉 `.write(`。）
   */
  assert.ok(
    offenders.some((o) => o.startsWith("server.ts")),
    "连 server.ts 那处已知的直写都没扫到 —— 扫描器坏了，这一项的绿灯不作数",
  );
  // server.ts 的管线兜底是已知的一处，它自己补齐了全部字段（有注释说明）
  const unknown = offenders.filter((o) => !o.startsWith("server.ts"));
  assert.deepEqual(
    unknown,
    [],
    "下面这些地方绕开了 res.json 直接写响应，盖不到 requestId：\n     " + unknown.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/6 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("接口响应格式：6 项全部通过");
