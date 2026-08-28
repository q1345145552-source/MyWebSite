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
      /**
       * ⚠️ **按「本行 + 后 3 行」一起看**（2026-08-29 补）。
       * 逐行扫描漏掉了跨行写法，而 server.ts 那处管线兜底恰恰就是跨行的：
       *     rawRes.end(
       *       JSON.stringify({ ... })
       * 也就是说这个扫描器**一处直写都没真正认出来**，
       * 我上一轮加的「必须至少认出 server.ts」那条自检，
       * 是靠同文件里另一处单行写法**蒙对的**。
       */
      const rawLines = fs.readFileSync(full, "utf-8").split("\n");
      rawLines.forEach((_l, i) => {
        const line = rawLines.slice(i, i + 4).join("\n");
        /**
         * 绕开 res.json 直接往 socket 写 JSON 的，盖章盖不到，必须自己补齐字段。
         *
         * ⚠️ 2026-08-29 补 write / send：原来只认 `.end(JSON.stringify` ——
         * 独立变异把一处改成 `rawRes.write(JSON.stringify(...))`，
         * **6 项照样全绿**。同一件事换个方法名就漏掉了。
         */
        if (
          /\.(end|write|send)\(\s*JSON\.stringify/.test(line) ||
          // ⚠️ 方括号写法（2026-08-29 补，第七轮复核实测能绕过）：
          //   rawRes["write"](JSON.stringify(...))
          // 点号那条正则完全看不见它。当前代码里没有这种写法，
          // 所以这是**测试守卫的缺口**，不是线上行为的错。
          /\[\s*["'`](end|write|send)["'`]\s*\]\s*\(\s*JSON\.stringify/.test(line)
        ) {
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

check("7) 业务代码**物理上**拿不到原始 socket（这条比扫正则可靠得多）", () => {
  /**
   * ⚠️⚠️ 2026-08-29 想清楚的一件事，比上面第 6 项重要。
   *
   * 第八轮复核报了三种能绕过第 6 项正则的写法：
   *   `Reflect.apply(rawRes.write, ...)`、解构 `const { write } = rawRes`、
   *   `const m = "write"; rawRes[m](...)`。
   * 确实全都绕得过。但**继续加正则是追不完的** —— 间接调用的花样无穷无尽。
   *
   * 实测之后发现根本不用追：`createJsonResponse` 返回的是一个
   * **只有 requestId / status / json 三个成员的新对象**，
   * 业务 handler 拿到的就是它，上面**根本没有 write / end / socket**。
   * 那三种「绕法」在真实代码里会直接 TypeError 崩掉（我跑过）。
   *
   * 所以真正该守的是**这个结构保证本身**：
   *   ① handler 拿到的 res 只暴露 status / json
   *   ② 业务模块里谁都碰不到原始 ServerResponse
   * 这两条守住了，间接调用有多少花样都无所谓 —— 没有东西可调。
   */
  const probe: any = { statusCode: 0, setHeader() {}, end() {} };
  const res = createJsonResponse(probe as never);
  const exposed = new Set<string>();
  for (let o = res as any; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) exposed.add(k);
  }
  const dangerous = ["write", "end", "socket", "connection", "writeHead", "flushHeaders", "pipe"];
  const leaked = dangerous.filter((k) => exposed.has(k) || typeof (res as any)[k] === "function");
  assert.deepEqual(
    leaked,
    [],
    `handler 拿到的 res 上暴露了原始 socket 的方法：${leaked.join("、")}\n` +
      `     —— 一旦暴露，业务代码就能绕开盖章那一步，而且怎么绕都拦不住`,
  );
  assert.deepEqual(
    [...exposed].sort(),
    ["json", "requestId", "status"],
    "res 暴露的成员变了。多一个就多一条能绕过盖章的路，请确认是不是有意的",
  );
});

check("8) 业务模块里谁都不许碰原始 ServerResponse", () => {
  /**
   * 第 7 项保证「拿到的 res 是干净的」，这一项保证「没人从别处把 socket 弄进来」。
   * 两条合起来，第 6 项那种追正则的活就只剩 server.ts 一个文件要管了。
   */
  const modulesRoot = path.join(__dirname, "..", "apps", "api", "src", "modules");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        if (/\bServerResponse\b|\brawRes\b|\bres\.socket\b|\bres\.connection\b/.test(line)) {
          offenders.push(`${path.relative(modulesRoot, full)}:${i + 1}  ${t.slice(0, 80)}`);
        }
      });
    }
  };
  walk(modulesRoot);
  assert.deepEqual(
    offenders,
    [],
    "下面这些业务模块碰到了原始 socket，等于给自己开了一条绕开盖章的路：\n     " +
      offenders.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/8 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("接口响应格式：8 项全部通过");
