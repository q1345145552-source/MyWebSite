import crypto from "node:crypto";

/**
 * 退出登录用的令牌黑名单（2026-08-31 新增，排查报告第 58 条）。
 *
 * ## 为什么要有这个
 *
 * 原来「退出账号」只是前端把本机存的令牌删掉，服务器根本不知道 ——
 * 令牌要是在退出前被人抄走了（比如在别人电脑上登过、被按 F12 复制），
 * 退出之后那份抄走的照样能用，最长 7 天。
 * 现在退出时调 /auth/logout，把这张令牌记进这里，之后再拿它来就不认了。
 *
 * ## 为什么是内存实现（有意为之，不是偷懒）
 *
 * 跟 rate-limit.ts 一个思路：这套系统一共 80 来个账号、单实例部署，
 * 黑名单条目 = 退出次数，撑死几百条，放内存足够。
 * ⚠️ **API 一重启黑名单就清空** —— 重启前退出的令牌又能用了。
 * 这是接受了的代价：本来这些令牌在旧方案里全程都能用，现在只是
 * 「重启前的那几张」退回旧状态，风险窗口只小不大。要根治得上 Redis，
 * 但为这个场景引入 Redis 依赖不值当（怀疑令牌泄漏时改一次密码就能全部作废，
 * 那条路走的是令牌里的密码指纹，不依赖本模块，见 auth/session-guard.ts）。
 *
 * ⚠️ 存的是令牌的 SHA-256 摘要，不存令牌本身 —— 万一日志或内存快照泄漏，
 *    也拼不回能用的令牌。
 */

/** 摘要 -> 这张令牌自己的过期时间（毫秒）。到点了留着没意义，清理定时器会删。 */
const revokedTokens = new Map<string, number>();

// 跟 rate-limit.ts 一样每 60 秒清一次过期条目（unref 免得拖住进程退出）
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of revokedTokens) {
    if (now >= expiresAt) revokedTokens.delete(key);
  }
}, 60_000).unref();

function tokenDigest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

/**
 * 把一张令牌拉黑。
 * @param tokenExpSec 令牌自带的过期时间（秒，即 payload.exp）——
 *   黑名单条目只需要活到令牌自己过期那一刻，之后校验环节本来就不认它了。
 */
export function revokeToken(token: string, tokenExpSec: number): void {
  const expiresAtMs = tokenExpSec * 1000;
  if (expiresAtMs <= Date.now()) return; // 已经过期的令牌不用记
  revokedTokens.set(tokenDigest(token), expiresAtMs);
}

/** 这张令牌是不是已经退出作废了 */
export function isTokenRevoked(token: string): boolean {
  const expiresAt = revokedTokens.get(tokenDigest(token));
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    // 令牌自己已过期，条目顺手删掉；此时校验链路的过期检查也会拒它
    revokedTokens.delete(tokenDigest(token));
    return false;
  }
  return true;
}

/**
 * 直接拿 Authorization 请求头判断（给校验链路用，省得每个调用点都自己拆 Bearer）。
 * 头格式不对的这里不管 —— 那是认证环节自己就会拒掉的情况。
 */
export function isAuthHeaderRevoked(authorization: string | string[] | undefined): boolean {
  const header = typeof authorization === "string" ? authorization.trim() : "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? isTokenRevoked(token) : false;
}
