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
import type { HttpResponse } from "../apps/api/src/server";

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
 * ⚠️ 这一项是这个脚本真正的价值所在。
 *
 * ①②③ 只能证明 ok()/fail() 自己是对的 —— 而当初出问题的地方，
 * 恰恰是**绕开它们自己拼响应体**的那几处。人会忘，所以让脚本每次都扫一遍。
 */
check("4) 后端没有任何地方绕开 ok()/fail() 自己拼响应体", () => {
  const apiRoot = path.join(__dirname, "..", "apps", "api", "src");
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf-8");
      text.split("\n").forEach((line, i) => {
        // 找 `.json({` 里直接写 code: 的：那就是在自己拼响应体
        if (/\.json\(\s*\{/.test(line) && /code\s*:/.test(line)) {
          offenders.push(`${path.relative(apiRoot, full)}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
        // 跨行写法：`.json({` 单独一行，紧接着下一行是 code:
        if (/\.json\(\s*\{\s*$/.test(line)) {
          const next = text.split("\n")[i + 1] ?? "";
          if (/^\s*code\s*:/.test(next)) {
            offenders.push(`${path.relative(apiRoot, full)}:${i + 1}  （跨行）${next.trim().slice(0, 60)}`);
          }
        }
      });
    }
  };
  walk(apiRoot);

  // http-utils.ts 本身就是拼响应体的地方，它是唯一的例外
  const real = offenders.filter((o) => !o.startsWith("modules/core/http-utils.ts"));
  assert.deepEqual(
    real,
    [],
    "下面这些地方绕开了 ok()/fail() 自己拼响应体，会漏掉 errors/requestId/timestamp：\n     " +
      real.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/4 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("接口响应格式：4 项全部通过");
