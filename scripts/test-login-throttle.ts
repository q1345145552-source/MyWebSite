/**
 * ⚠️ 禁库硬闸：这个脚本不许连数据库。
 * 下面第 16 项会**真调 /auth/login**，而登录路由在闸之后会去查用户表 ——
 * 闸生效时根本走不到那一步；一旦闸失效，就会以「连不上数据库」的形式当场炸出来。
 * 这正好是我们要的：**闸没生效 = 测试红**。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

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
  clearLoginFailures,
  isFailureBlocked,
  isLoginBlocked,
  loginFailureKey,
  loginRetryAfterMs,
  recordFailure,
  recordLoginFailure,
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
  assert.equal(key, "XT001::login-account", `限流键的构成变了：${key}`);
});

/**
 * 原第 4 项「大小写不同的同一个账号算同一个桶」**已删除**（2026-08-29）。
 * 那条断言的是旧口径（按小写记），而旧口径本身就是第 11 项那个洞的病根。
 * 新口径由第 12 项守着：大小写不同 = 不同账号，各算各的。
 * ⚠️ 别看到编号跳了就顺手补一项回来 —— 补回来会跟第 11、12 项打架。
 */

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
  const recordCount = (loginBody.match(/recordLoginFailure\(body\.account\)/g) ?? []).length;
  assert.equal(
    recordCount,
    3,
    `登录里记失败的地方有 ${recordCount} 处，应该是 3 处（账号不存在/被封、role 对不上、密码错）`,
  );
  assert.ok(loginBody.includes("clearLoginFailures(body.account)"), "登录成功没有清零计数");
  assert.ok(
    loginBody.includes("loginRetryAfterMs(body.account)"),
    "登录接口没用共用的 loginRetryAfterMs，自己现拼了限流键 —— 那样测试守不住它",
  );
  assert.ok(
    !/rateLimitKey\(\s*body\.account/.test(loginBody),
    "登录接口又自己拼限流键了，请统一走 core/rate-limit 里那几个 login* 函数",
  );
  assert.ok(
    !/toLowerCase\(\)/.test(loginBody),
    "又把账号转小写了 —— 那正是第 11 项那个洞的病根（合法登录能抹掉别人的计数）",
  );
});


check("11) 复核实测那个洞：用大小写不同的账号登录成功，不许把别人的计数清掉", () => {
  /**
   * 第七轮复核实测出来的（我复现了）：
   *   ① 对 `admin` 猜错 19 次
   *   ② 用 `Admin` 正常登录成功 → 清零
   *   ③ 再猜 `admin` 第 20 次 → **仍然放行**
   * 病根：查库区分大小写，计数键却统一转小写，
   * 于是一个**合法登录**就能把另一个账号的失败计数抹掉。
   */
  for (let i = 0; i < 19; i += 1) recordLoginFailure("admin");
  assert.equal(isLoginBlocked("admin"), false, "才 19 次就被拦了");

  clearLoginFailures("Admin"); // ② Admin 登录成功

  recordLoginFailure("admin"); // ③ 第 20 次
  assert.equal(
    isLoginBlocked("admin"),
    true,
    "用 Admin 登录成功把 admin 的计数清掉了 —— 这道闸能被一个合法登录抹掉",
  );
});

check("12) 大小写不同 = 不同账号，各算各的（跟查库同一个口径）", () => {
  /**
   * ⚠️ 口径 2026-08-29 反过来了，注意别改回去。
   * 原来我按小写记，理由是「不然换个大小写就是新桶」。那个理由不成立：
   * 攻击者拿错的大小写去猜，库里查不到这个人，**不管密码对不对都是 401**，
   * 他得不到任何信息，只能死磕正确的那个写法。
   * 反倒是按小写记开了个洞（见第 11 项）。
   *
   * 现在跟 `findUnique({id})` 完全一致：`admin` 和 `Admin` 就是两个账号。
   */
  for (let i = 0; i < 20; i += 1) recordLoginFailure("admin");
  assert.equal(isLoginBlocked("admin"), true, "猜满 20 次的那个写法没被拦");
  assert.equal(
    isLoginBlocked("Admin"),
    false,
    "把另一个写法也连坐了 —— 那是另一个账号，不该受影响",
  );
});

check("13) 本人登录成功，自己的计数要清掉（别把正常人关在门外）", () => {
  /**
   * 上一项的修法不能修过头：`admin` 自己打错几次、然后登录成功，
   * 那几次必须清掉，否则他白天陆续打错就会把自己累积到 20。
   */
  for (let i = 0; i < 19; i += 1) recordLoginFailure("XT001");
  clearLoginFailures("XT001"); // ← 本人登录成功
  for (let i = 0; i < 19; i += 1) recordLoginFailure("XT001");
  assert.equal(isLoginBlocked("XT001"), false, "本人登录成功之后计数没清掉");
});

check("14) 还是只挡被敲的那个账号，别连累别人", () => {
  for (let i = 0; i < 20; i += 1) recordLoginFailure("XT001");
  assert.equal(isLoginBlocked("XT001"), true);
  assert.equal(isLoginBlocked("XT002"), false, "把没被敲的账号也挡了");
  assert.equal(isLoginBlocked("xt001x"), false, "把名字相近的账号也挡了");
});

check("15) 登录接口走的是共用的那几个 login* 函数（源码检查）", () => {
  /**
   * ⚠️ 这一项只能证明「代码里写了这几个字」，证明不了行为 ——
   * 包进 `if (false)` 它就抓不到了（2026-08-29 在产品行校验上刚栽过）。
   * 真正的守卫是上面 11~14 项。这一项只防「有人把它改回单桶写法」。
   */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "apps", "api", "src", "modules", "auth", "routes.ts"),
    "utf-8",
  );
  const loginBody = src
    .slice(src.indexOf('app.post("/auth/login"'), src.indexOf('app.post("/auth/register"'))
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  assert.equal(
    (loginBody.match(/recordLoginFailure\(body\.account\)/g) ?? []).length,
    3,
    "记失败的地方不是 3 处（账号不存在/被封、role 对不上、密码错）",
  );
  assert.ok(loginBody.includes("clearLoginFailures(body.account)"), "登录成功没清零");
  assert.ok(loginBody.includes("loginRetryAfterMs(body.account)"), "没用双桶的拦截判断");
  assert.ok(
    !/clearFailures\(/.test(loginBody),
    "又改回直接调 clearFailures 了 —— 请统一走 clearLoginFailures，口径才跟查库一致",
  );
});


// ══════════════════════════════════════════════════════════════════
// ⚠️⚠️ 下面这一项是**真调 /auth/login**，不是测纯函数。
//
// 复核连着三轮报同一件事：这个脚本的 15 项**一次都没调过登录接口** ——
// 1~9、11~14 测的是 core/rate-limit.ts 里的纯函数，10 和 15 只扫源码
// 有没有那几个字。把账号锁定那道闸改成永不触发，15/15 照样全绿。
// 复核还明说了「这道闸完全可以零成本真调」。它是对的，我拖了两轮没做。
//
// 怎么做到不连库：账号锁定这道闸在登录流程里排在**查用户表之前**。
// 所以先用真的 recordLoginFailure 把计数灌满，再调路由：
//   · 闸生效 → 直接 429 返回，根本走不到查库那一步
//   · 闸失效 → 往下走去查库 → 数据库连不通 → 当场炸
// 两种结果都能把「闸有没有接上」区分开。
// ══════════════════════════════════════════════════════════════════

type Handler = (req: any, res: any) => Promise<void> | void;

async function loadLoginRoute(): Promise<Handler> {
  const routes = new Map<string, Handler>();
  const { registerAuthRoutes } = await import("../apps/api/src/modules/auth/routes");
  registerAuthRoutes({
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  } as any);
  const h = routes.get("POST /auth/login");
  assert.ok(h, "没注册 /auth/login");
  return h!;
}

async function callLogin(
  handler: Handler,
  body: unknown,
  ip: string,
): Promise<{ status: number; message: string; threw: string | null }> {
  let status = 0;
  let payload: { message?: string } = {};
  const res: any = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { payload = value as { message?: string }; },
  };
  try {
    await handler(
      { method: "POST", path: "/auth/login", query: {}, headers: { "x-real-ip": ip }, body },
      res,
    );
  } catch (e) {
    return { status, message: payload.message ?? "", threw: e instanceof Error ? e.message : String(e) };
  }
  return { status, message: payload.message ?? "", threw: null };
}

async function main(): Promise<void> {
  const login = await loadLoginRoute();

  await checkAsyncTop("16) 账号锁定那道闸**真的接在登录路由上**（真调接口）", async () => {
    __resetFailureStoreForTest();
    const account = "XT_GATE_TEST";
    // 灌满这个账号的失败计数（用的是生产那份 recordLoginFailure）
    for (let i = 0; i < LOGIN_FAILURE_MAX; i += 1) recordLoginFailure(account);

    /**
     * ⚠️ 每次换一个 IP：不然会先撞上「每 IP 每分钟 10 次」那道旧闸，
     * 拿到的 429 就分不清是哪道闸发的了。
     */
    const r = await callLogin(login, { account, password: "随便错的" }, "10.0.0.99");

    assert.equal(
      r.threw,
      null,
      `路由抛异常了，说明它绕过账号闸去查库了（闸没接上）：${r.threw}`,
    );
    assert.equal(r.status, 429, `账号已经错满 ${LOGIN_FAILURE_MAX} 次，却没被拦，拿到 ${r.status}`);
    assert.ok(
      /密码错太多次|分钟后再试/.test(r.message),
      `拦是拦了，但不是账号锁定那道闸发的：${JSON.stringify(r.message)}`,
    );
  });

  await checkAsyncTop("17) 没超限的账号不许被误拦（正向对照）", async () => {
    /**
     * ⚠️ 只验「没被账号闸拦下」。没超限的请求会往下走去查库，
     * 而本脚本禁了数据库 —— 所以它**应该抛连库错误**，
     * 那正好证明它穿过了账号闸。
     */
    __resetFailureStoreForTest();
    const r = await callLogin(login, { account: "XT_CLEAN", password: "x" }, "10.0.0.100");
    assert.notEqual(r.status, 429, "没超限的账号被账号闸拦了");
    assert.ok(
      r.threw !== null,
      "既没被拦、也没往下走去查库 —— 说明它在别的地方就返回了，这一项没测到东西",
    );
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/17 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("登录限流：17 项全部通过");
}

async function checkAsyncTop(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
