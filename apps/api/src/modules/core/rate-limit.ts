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
