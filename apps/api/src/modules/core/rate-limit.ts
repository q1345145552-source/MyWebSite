/**
 * 简易内存级速率限制器。
 * 生产环境建议替换为 Redis 实现（利用 REDIS_URL 环境变量）。
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// 每 60 秒清理一次过期条目（幂等，防止热重载重复创建）
if (!cleanupInterval) {
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 60_000).unref();
}

/**
 * 检查是否超过速率限制。
 * @returns true 表示被限制，false 表示允许放行。
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = 10,
  windowMs: number = 60_000,
): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return false; // 放行
  }

  entry.count++;
  if (entry.count > maxRequests) {
    return true; // 限流
  }

  return false;
}


/**
 * ════════════════════════════════════════════════════════════════════
 * 按「被敲的那个账号」计数的失败限流（2026-08-29 新增，老板拍板 30 分钟 20 次）
 * ════════════════════════════════════════════════════════════════════
 *
 * 上面 checkRateLimit 是按 **IP** 算的：一个 IP 一分钟 10 次。
 * 问题是换个 IP 计数就从 0 重新开始 —— 攻击者拿 100 台机器一起猜**同一个账号**，
 * 每台各 10 次都不超限，一分钟 1000 次、一天 144 万次，
 * 而系统全程没有任何地方记录「这个账号被猜了多少次」。
 *
 * 改密码接口（auth/routes.ts）早就是按账号算的，注释写着
 *   「换 IP 就能继续猜旧密码的话，这道限流等于没有」
 * —— 登录这边恰恰漏了同样一道。
 *
 * ⚠️ 只数**猜错的**：密码对了不计数，而且登录成功会把计数清零。正常人不受影响。
 *
 * ⚠️ 已知代价（跟老板说过）：知道某个员工唛头的人，可以故意连错 20 次
 *    把他挡在外面最多半小时。这是账号锁定这类做法的通病，
 *    换来的是把「一天 144 万次猜密码」压到「一天 960 次」。
 *    本系统 69/75 个客户账号的密码就是唛头本身，挡批量试比防这个更要紧。
 *
 * ⚠️ 计数在**进程内存**里，API 一重启就清零，多实例也各算各的。
 *    这是整个限流模块的共同前提（见文件开头），要根治得上 Redis。
 */
interface FailureEntry {
  count: number;
  /** 这个计数窗口什么时候归零 */
  resetAt: number;
}

const failureStore = new Map<string, FailureEntry>();

// 跟上面的 store 一样定期清理，免得内存里越攒越多
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failureStore) {
    if (now > entry.resetAt) failureStore.delete(key);
  }
}, 60_000).unref();

/** 一个账号在一个窗口里最多能失败几次 */
export const LOGIN_FAILURE_MAX = 20;
/** 计数窗口：30 分钟 */
export const LOGIN_FAILURE_WINDOW_MS = 30 * 60_000;

/**
 * 这个键现在是不是已经超限了。
 * ⚠️ **只查不加**：加计数是 recordFailure 的事。
 * 两件事必须分开，否则「登录成功」也会被算成一次尝试。
 */
export function isFailureBlocked(
  key: string,
  max: number = LOGIN_FAILURE_MAX,
  now: number = Date.now(),
): boolean {
  const entry = failureStore.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= max;
}

/** 还要等多少毫秒才能再试（没被挡就是 0）—— 用来给人一句看得懂的提示 */
export function failureRetryAfterMs(
  key: string,
  max: number = LOGIN_FAILURE_MAX,
  now: number = Date.now(),
): number {
  const entry = failureStore.get(key);
  if (!entry || now > entry.resetAt || entry.count < max) return 0;
  return entry.resetAt - now;
}

/** 记一次失败。窗口过期就重新开一个新窗口。 */
export function recordFailure(
  key: string,
  windowMs: number = LOGIN_FAILURE_WINDOW_MS,
  now: number = Date.now(),
): void {
  const entry = failureStore.get(key);
  if (!entry || now > entry.resetAt) {
    failureStore.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
}

/** 登录成功后把这个账号的失败计数清掉 —— 不清的话，白天陆续打错几次会累积到超限 */
export function clearFailures(key: string): void {
  failureStore.delete(key);
}

/**
 * 登录失败计数用的键 —— **生产和测试必须共用这一个函数**。
 *
 * ⚠️ 2026-08-29：这个函数原来没有，键是在登录接口里现拼的，
 * 测试脚本自己又照着抄了一遍。做变异时把生产那句改成
 *   `rateLimitKey(`${ip}_${account}`, "login-account")`
 * —— **10 项照样全绿**，因为测试比对的是它自己抄的那份。
 * 「测试重写一遍被测逻辑」＝ 测了个寂寞。
 *
 * ⚠️⚠️ **按账号原样计数，不许转小写**（2026-08-29 第七轮复核之后改的）。
 *
 * 我原来在这里 `.toLowerCase()`，理由写的是「不然换个大小写就是一个新计数桶」。
 * **那个理由是错的**，而且它自己开了个洞：
 *
 *   洞（复核实测）：查库是 `findUnique({id: body.account})`，**区分大小写**；
 *   计数却按小写。于是 ① 对 `admin` 猜错 19 次 → ② 用 `Admin` 正常登录成功
 *   → 清零，清掉的是同一个桶 → ③ 再猜 `admin` 第 20 次仍然放行。
 *   **一个合法登录就能把这道闸抹掉。**
 *
 *   为什么原来那个理由是错的：攻击者拿**错的大小写**去猜根本没有意义 ——
 *   `xt001` 在库里查不到这个人，不管密码对不对都是 401，
 *   他从这条路上得不到任何关于密码的信息。他只能死磕**正确的那个写法**，
 *   而那个写法的计数是准的。所以「换大小写躲开计数」这件事本身不成立。
 *
 *   我第一版的修法是「记两个桶（小写 + 原样），成功只清原样桶」——
 *   那个也不行：本人（`XT001`）白天陆续打错几次，小写桶 `xt001` 永远清不掉，
 *   累积到 20 就把**他自己**关在门外了。自测第 13 项当场逮住的就是这个。
 *
 * 所以：**原样计数、原样清零**，一个桶，口径跟查库完全一致。
 * ⚠️ 键里同样不许出现 IP —— 整道闸的意义就是「换 IP 也躲不掉」。
 */
export function loginFailureKey(account: string): string {
  return rateLimitKey(account.trim(), "login-account");
}

/** 这个账号现在是不是被拦着 */
export function isLoginBlocked(account: string, now: number = Date.now()): boolean {
  return isFailureBlocked(loginFailureKey(account), LOGIN_FAILURE_MAX, now);
}

/** 还要等多少毫秒 */
export function loginRetryAfterMs(account: string, now: number = Date.now()): number {
  return failureRetryAfterMs(loginFailureKey(account), LOGIN_FAILURE_MAX, now);
}

/** 记一次登录失败 */
export function recordLoginFailure(account: string, now: number = Date.now()): void {
  recordFailure(loginFailureKey(account), LOGIN_FAILURE_WINDOW_MS, now);
}

/** 登录成功后清零 —— 清的就是它自己那个桶，跟查库同一个口径 */
export function clearLoginFailures(account: string): void {
  clearFailures(loginFailureKey(account));
}

/** 测试用：把失败计数全清了（生产代码不要调） */
export function __resetFailureStoreForTest(): void {
  failureStore.clear();
}

/**
 * 根据 IP 和路径生成限流键。
 */
export function rateLimitKey(ip: string, path: string): string {
  return `${ip}::${path}`;
}

/**
 * 从请求头中提取客户端 IP。
 *
 * ⚠️ 2026-08-05 修的一个真漏洞：
 * 原来先读 `X-Forwarded-For` 的**第一段**，而第一段是**请求方自己填的**。
 * nginx 用的是 `$proxy_add_x_forwarded_for`（在客户端已有的值后面**追加**真实 IP），
 * 所以第一段永远是外面传进来的，可以随便伪造。限流按它计数 →
 * 每换一个假 IP 就是一个全新的计数桶 → 限流形同虚设。
 * 本地实测：同一个假 IP 发 14 次，前 10 次放行后开始 429；每次换一个假 IP 发 14 次，全部放行。
 *
 * 现在的取值顺序：
 *   ① `X-Real-IP` —— nginx 那行是 `proxy_set_header X-Real-IP $remote_addr`，
 *      **覆盖式**赋值，客户端传什么都会被盖掉，伪造不了
 *   ② `X-Forwarded-For` 的**最后一段** —— 那是最靠近本服务器的一跳追加上去的
 *   ③ 都没有 → unknown
 *
 * ⚠️ 前提是请求经过 nginx。直接连 3001 端口的人仍可自己编 X-Real-IP——
 * 所以同一天把 3000/3001 从公网收回了（docker-compose 改成只绑 127.0.0.1），那条路已封死。
 * **这两处是一套的，改 docker-compose 的端口绑定前先回来看这段注释。**
 */
export function getClientIp(headers: NodeJS.Dict<string | string[]>): string {
  const realIp = headers["x-real-ip"];
  const realIpText = typeof realIp === "string" ? realIp : Array.isArray(realIp) ? realIp[realIp.length - 1] : "";
  if (realIpText?.trim()) return realIpText.trim();

  // Node 会把重复的同名头用 ", " 合成一个字符串，数组分支基本走不到，保险起见一并处理
  const forwarded = headers["x-forwarded-for"];
  const forwardedText =
    typeof forwarded === "string" ? forwarded : Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : "";
  if (forwardedText) {
    const hops = forwardedText.split(",").map((item) => item.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }

  return "unknown";
}
