import { prisma } from "../../db/prisma";
import { passwordFingerprint, type AuthTokenPayload } from "./token";

/**
 * 令牌签名对、还没过期，**不代表这个人现在还能用系统**（2026-08-25 新增）。
 *
 * ## 原来的问题
 *
 * 认证只验签名和过期时间，一次都不回头看这个账号现在什么样。于是：
 * - 管理员把一个账号**封禁**了，那人手上的令牌照样能用，**最长 7 天**。
 *   而封禁是这个系统停用账号的**唯一手段**（删除账号已经关掉了），
 *   等于「封了但没真封住」。
 * - 客户怀疑账号被盗、**改了密码**，小偷手上的旧令牌一样还能用 7 天。
 *
 * ## 现在怎么做
 *
 * 每个请求多查一次这个用户的 status 和密码哈希：
 * - `status` 不是 active → 直接当没登录
 * - 令牌里的密码指纹跟现在的密码对不上 → 直接当没登录
 *
 * ⚠️ 只查两个字段、按主键查，代价很小；这套系统一共 82 个账号、并发很低。
 * ⚠️ 用户查不到也拒掉 —— 账号真被删了就不该还能用。
 * ⚠️ **老令牌里没有 pv 字段的一律放行**：这次上线时所有人手上的都是老令牌，
 *    不放行就等于全站当场强制重新登录。它们最多 7 天后自己过期，
 *    之后签发的就都带指纹了。
 */
export async function isSessionStillValid(payload: AuthTokenPayload): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { status: true, passwordHash: true },
  });
  if (!user) return { ok: false, reason: "账号不存在（可能已被删除）" };
  if (user.status !== "active") return { ok: false, reason: "账号已被封禁" };
  if (payload.pv && payload.pv !== passwordFingerprint(user.passwordHash)) {
    return { ok: false, reason: "密码已修改，旧登录状态失效" };
  }
  return { ok: true };
}
