/**
 * 登录限流的自测（不连数据库、不连网络，只测计数逻辑本身）。
 *
 * 为什么要有这个（老板 2026-08-29 拍板加的那道闸）：
 * 登录本来就有限流，但是按 **IP** 算的 —— 换个 IP 计数就从 0 重新开始。
 * 攻击者拿 100 台机器一起猜**同一个账号**，每台各 10 次都不超限，
 * 一分钟 1000 次、一天 144 万次，而系统全程没有任何地方记录
 * 「这个账号被猜了多少次」。
 *
 * 现在加了第二道：同一个账号，30 分钟内错 20 次就先拒绝。
 *
 * ⚠️ 这里测的是**计数规则**，不是整条登录链路（那要连库）。
 *    所以下面每一项都写清楚它对应登录接口里的哪一行，改代码时两边要一起看。
 */
import assert from "node:assert/strict";
import {
  LOGIN_FAILURE_MAX,
  LOGIN_FAILURE_WINDOW_MS,
  __resetFailureStoreForTest,
  clearFailures,
  failureRetryAfterMs,
  isFailureBlocked,
  loginFailureKey,
  recordFailure,
} from "../apps/api/src/modules/core/rate-limit";

const failures: string[] = [];
function check(name: string, body: () => void): void {
  __resetFailureStoreForTest();
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/**
 * ⚠️ **直接用生产代码那个函数**，不许在这里自己再拼一遍。
 * 第一版就是自己抄了一份，结果把生产那句改成把 IP 拼进键里（正是我们要修的病根），
 * 10 项照样全绿 —— 测试比对的是它自己抄的那份。
 * 「测试重写一遍被测逻辑」＝ 测了个寂寞。
 */
const keyOf = loginFailureKey;

console.log("登录限流");

check("1) 老板定的就是 30 分钟 20 次（数字被人偷偷改小/改大都要red）", () => {
  assert.equal(LOGIN_FAILURE_MAX, 20, "失败次数上限不是 20");
  assert.equal(LOGIN_FAILURE_WINDOW_MS, 30 * 60_000, "计数窗口不是 30 分钟");
});

check("2) 错 19 次还能试，错满 20 次才拦（边界两头都测）", () => {
  const key = keyOf("XT001");
  // ⚠️ 用 19 / 20 两个相邻的数卡边界，只测「错很多次会被拦」是测不出差一位的
  for (let i = 0; i < 19; i += 1) recordFailure(key);
  assert.equal(isFailureBlocked(key), false, "才错 19 次就被拦了，正常员工会被误伤");
  recordFailure(key);
  assert.equal(isFailureBlocked(key), true, "错满 20 次还放行 —— 这道闸没生效");
});

check("3) 换 IP 不管用 —— 这就是加这道闸的全部意义", () => {
  /**
   * 这一项直接对着病根：老的限流键是 `IP::login`，
   * 100 台机器就是 100 个计数桶。新的键里**只有账号**，没有 IP，
   * 所以不管从哪台机器来，敲的是同一个账号就累加到同一个数上。
   */
  const key = keyOf("XT001");
  // 模拟 20 台不同机器，每台只敲 1 次
  for (let i = 0; i < 20; i += 1) recordFailure(key);
  assert.equal(isFailureBlocked(key), true, "换 IP 就绕过去了，等于没加");
  /**
   * 键里**只许有账号**。同一个账号不管从哪台机器来，
   * loginFailureKey 都必须给出同一个键 —— 键里一旦掺进 IP 或别的什么，
   * 100 台机器就又是 100 个计数桶，回到没加这道闸之前。
   */
  assert.equal(
    loginFailureKey("XT001"),
    loginFailureKey("XT001"),
    "同一个账号两次算出来的键都不一样",
  );
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(key), `限流键里混进了 IP：${key}`);
  // 键里除了账号和固定后缀不许有别的东西
  assert.equal(key, "xt001::login-account", `限流键的构成变了：${key}`);
});

check("4) 大小写不同的同一个账号算同一个桶", () => {
  /**
   * 不统一大小写的话，"XT001" 和 "xt001" 各算各的，
   * 攻击者换个大小写就是一个全新的计数桶 —— 这道闸等于白加。
   */
  for (let i = 0; i < 10; i += 1) recordFailure(keyOf("XT001"));
  for (let i = 0; i < 10; i += 1) recordFailure(keyOf("xt001"));
  assert.equal(isFailureBlocked(keyOf("Xt001")), true, "换个大小写就绕过去了");
});

check("5) 只挡被敲的那个账号，不许连累别人", () => {
  // ⚠️ 三个互不相同的账号，防止「一个数假绿」
  const victim = keyOf("XT001");
  for (let i = 0; i < 20; i += 1) recordFailure(victim);
  assert.equal(isFailureBlocked(victim), true, "被敲的账号没被挡");
  assert.equal(isFailureBlocked(keyOf("XT002")), false, "把没被敲的账号也挡了");
  assert.equal(isFailureBlocked(keyOf("XT003")), false, "把没被敲的账号也挡了");
});

check("6) 登录成功要把计数清零 —— 不清的话员工会把自己关在门外", () => {
  /**
   * 真实场景：一个员工一整天陆陆续续打错几次密码，中间都成功登录了。
   * 不清零的话这些零星的错会一路累积到 20，最后他自己被挡在外面。
   * 对应登录接口里 verifyPassword 通过之后那句 clearFailures。
   */
  const key = keyOf("XT001");
  for (let i = 0; i < 19; i += 1) recordFailure(key);
  clearFailures(key); // ← 登录成功
  for (let i = 0; i < 19; i += 1) recordFailure(key);
  assert.equal(isFailureBlocked(key), false, "登录成功之后计数没清零");
});

check("7) 过了 30 分钟自动放行，不用管理员手动解锁", () => {
  const key = keyOf("XT001");
  const t0 = 1_800_000_000_000; // 固定时间戳，不用 Date.now()，免得测试跟着时钟飘
  for (let i = 0; i < 20; i += 1) recordFailure(key, LOGIN_FAILURE_WINDOW_MS, t0);
  assert.equal(isFailureBlocked(key, LOGIN_FAILURE_MAX, t0 + 29 * 60_000), true, "29 分钟就放行了");
  assert.equal(isFailureBlocked(key, LOGIN_FAILURE_MAX, t0 + 31 * 60_000), false, "31 分钟还挡着，解不开了");
});

check("8) 还要等多久，报给人的数字要对得上", () => {
  const key = keyOf("XT001");
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 20; i += 1) recordFailure(key, LOGIN_FAILURE_WINDOW_MS, t0);
  // 过了 10 分钟 → 还剩 20 分钟
  assert.equal(failureRetryAfterMs(key, LOGIN_FAILURE_MAX, t0 + 10 * 60_000), 20 * 60_000);
  // 没超限的时候必须是 0，不能给正常人弹「请稍后再试」
  clearFailures(key);
  recordFailure(key, LOGIN_FAILURE_WINDOW_MS, t0);
  assert.equal(failureRetryAfterMs(key, LOGIN_FAILURE_MAX, t0), 0, "才错 1 次就跟人说要等");
});

check("9) 查和记必须是两件事 —— 光查不许把计数加上去", () => {
  /**
   * 老的 checkRateLimit 是「一边查一边加」，那种写法用在这里会出大事：
   * 登录**成功**也会被算成一次尝试，正常员工登 20 次就被自己挡住了。
   */
  const key = keyOf("XT001");
  for (let i = 0; i < 19; i += 1) recordFailure(key);
  for (let i = 0; i < 50; i += 1) isFailureBlocked(key); // 狂查 50 次
  assert.equal(isFailureBlocked(key), false, "光查就把计数加上去了 —— 正常登录会被误挡");
});

check("10) 登录接口里三个失败出口都记了一笔（源码检查）", () => {
  /**
   * 只在「密码错」那一处记的话，攻击者拿**不存在的账号**刷、
   * 或者用**错的 role** 刷，一次都不会被计数 —— 而那两条路照样能试账号存不存在。
   * 这一项直接读源码数，防的是以后有人改登录流程时漏掉某个 return。
   */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "apps", "api", "src", "modules", "auth", "routes.ts"),
    "utf-8",
  );
  const loginBody = src.slice(src.indexOf('app.post("/auth/login"'), src.indexOf('app.post("/auth/register"'));
  const recordCount = (loginBody.match(/recordFailure\(failureKey\)/g) ?? []).length;
  assert.equal(
    recordCount,
    3,
    `登录里记失败的地方有 ${recordCount} 处，应该是 3 处（账号不存在/被封、role 对不上、密码错）`,
  );
  assert.ok(loginBody.includes("clearFailures(failureKey)"), "登录成功没有清零计数");
  assert.ok(
    loginBody.includes("loginFailureKey(body.account)"),
    "登录接口没用共用的 loginFailureKey，自己现拼了限流键 —— 那样测试守不住它",
  );
  assert.ok(
    !/failureKey\s*=\s*rateLimitKey\(/.test(loginBody),
    "登录接口又自己拼限流键了，请统一走 loginFailureKey",
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/10 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("登录限流：10 项全部通过");
