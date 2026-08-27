/**
 * DeepSeek 调用超时的自测。
 *
 * 为什么要有这个：Node 的 fetch **默认不设超时**。对方卡住时请求会一直挂着
 * （要等 Node 默认 300 秒才断），而一条客户消息要串行调两次。
 * 客户等不到就去点重发，前一次的钱照付、新的一次再付一遍。
 *
 * 做法：在本机起一个「只收不回」的假服务器冒充 DeepSeek，
 * 把超时调到 300 毫秒，看客户端是不是真的自己断开。
 * 不连真的 DeepSeek、不花钱、不连数据库。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

const TIMEOUT_MS = 300;

/** 子进程模式：只把客户端模块 import 一遍，好看看模块加载时打了什么日志 */
const IS_WARN_PROBE = process.env.__DEEPSEEK_WARN_PROBE === "1";

async function main() {
  // 两种卡法都要能断开：① 连上就一声不吭；② 先把响应头发回来，再挂住不发 body
  const hangingServer = http.createServer((req, res) => {
    if (req.url?.includes("slow-body")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":[');
      // 故意不 end()，让响应体一直挂着
      return;
    }
    // 什么都不做：不写头、不结束
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
  const port = (hangingServer.address() as AddressInfo).port;

  process.env.DEEPSEEK_API_KEY = "test-key-not-real";
  process.env.DEEPSEEK_TIMEOUT_MS = String(TIMEOUT_MS);

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

  console.log("DeepSeek 调用超时");

  await check("1) 对方一声不吭时，300 毫秒后自己断开并报超时", async () => {
    process.env.DEEPSEEK_API_BASE_URL = `http://127.0.0.1:${port}/chat`;
    const { HttpDeepSeekClient: Client } = await import(
      "../apps/api/src/modules/ai/deepseek-client"
    );
    const started = Date.now();
    let caught: unknown;
    try {
      await new Client().summarizeWithContext({ question: "你好", context: "{}" });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    assert.ok(caught instanceof Error, "没有抛错，说明一直挂着");
    assert.ok(
      (caught as Error).message.includes("超时"),
      `报的不是超时：${(caught as Error).message}`,
    );
    // 给足余量，但必须远小于 Node 默认的 300 秒
    assert.ok(elapsed < 5_000, `等了 ${elapsed} 毫秒才断，超时没生效`);
  });

  await check("2) 头发回来了、body 挂住，也照样能断开", async () => {
    process.env.DEEPSEEK_API_BASE_URL = `http://127.0.0.1:${port}/chat/slow-body`;
    const { HttpDeepSeekClient: Client } = await import(
      "../apps/api/src/modules/ai/deepseek-client"
    );
    const started = Date.now();
    let caught: unknown;
    try {
      await new Client().summarizeWithContext({ question: "你好", context: "{}" });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    assert.ok(caught instanceof Error, "没有抛错：计时器可能在读 body 之前就被清掉了");
    assert.ok(elapsed < 5_000, `等了 ${elapsed} 毫秒才断`);
  });

  await check("3) DEEPSEEK_TIMEOUT_MS 填了非正整数时退回默认值并留一条日志", async () => {
    // 超时值是模块级常量、加载那一刻就定死了，同一个进程里改不回来，所以另起一个进程验。
    // 日志走的是 console.warn（stderr），stdout 和 stderr 都要看。
    const probe = spawnSync(process.execPath, ["--import", "tsx", __filename], {
      encoding: "utf-8",
      env: { ...process.env, __DEEPSEEK_WARN_PROBE: "1", DEEPSEEK_TIMEOUT_MS: "-5" },
    });
    const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    assert.equal(probe.status, 0, `子进程没正常退出：\n${out}`);
    assert.ok(
      out.includes("DEEPSEEK_TIMEOUT_MS 不是正整数"),
      `没有退回默认值的日志，可能被当成了「不限时」：\n${out}`,
    );
  });

  hangingServer.close();
  if (failures.length > 0) {
    throw new Error(`${failures.length}/3 项不通过：${failures.join("；")}`);
  }
  console.log("DeepSeek 超时：3 项全部通过");
}

if (IS_WARN_PROBE) {
  // 只加载模块、让它把警告打出来，然后立刻退出，不跑下面那套测试
  void import("../apps/api/src/modules/ai/deepseek-client").then(() => process.exit(0));
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
