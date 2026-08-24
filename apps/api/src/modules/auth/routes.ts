import type { MinimalHttpApp } from "../../server";
import { prisma } from "../../db/prisma";
import { fail, ok, requireAuth } from "../core/http-utils";
import { logger } from "../core/logger";
import { checkRateLimit, getClientIp, rateLimitKey } from "../core/rate-limit";
import { signAuthToken } from "./token";
import { hashPassword, verifyPassword } from "./crypto-utils";
import { checkPasswordStrength } from "./password-policy";

/**
 * 注册鉴权路由（登录 + 注册）
 *
 * ⚠️ B-2 改造：内部已完全切换到 Prisma + PostgreSQL。
 * 第二个参数 `_db` 保留只是为了兼容 main.ts 的调用签名，不再使用。
 * 等所有模块迁移完成后会从签名中移除。
 */
export function registerAuthRoutes(app: MinimalHttpApp): void {
  app.post("/auth/login", async (req, res) => {
    // 速率限制：每个 IP 每分钟最多 10 次登录尝试
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "login"), 10, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "too many login attempts, please try again later");
      return;
    }
    // 2026-08-04：原来直接 body.account?.trim()，账号传成数字/数组/对象时
    // .trim 不是函数 → 抛异常 → 500（日志里 5 次 "body.account?.trim is not a function"）。
    // 登录是完全对公网开放的入口，任何人都能随手打崩它一次，必须先卡类型。
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const body = {
      account: asStr(raw.account),
      password: typeof raw.password === "string" ? raw.password : "",
      role: asStr(raw.role),
    };
    if (!body.account) {
      fail(res, 400, "BAD_REQUEST", "account is required");
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: body.account },
      select: {
        id: true,
        companyId: true,
        role: true,
        name: true,
        status: true,
        passwordHash: true,
      },
    });

    if (!user || user.status !== "active") {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (body.role && body.role !== user.role) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (!verifyPassword(body.password, user.passwordHash)) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }

    const token = signAuthToken({
      userId: user.id,
      companyId: user.companyId,
      role: user.role as "admin" | "staff" | "client",
      userName: user.name,
      // 把密码指纹写进令牌：以后改了密码，这张令牌立刻失效，不用等 7 天
      passwordHash: user.passwordHash,
    });

    ok(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
      },
    });
  });

  app.post("/auth/register", async (req, res) => {
    fail(res, 403, "FORBIDDEN", "自助注册已关闭，请联系管理员");
  });

  /**
   * 改自己的密码（三端通用：管理员 / 员工 / 客户都能用）。
   *
   * 2026-08-07 新增。原来只有 /admin/users/set-password，而那个接口写死了
   * 「只准改 staff 和 client」—— 管理员自己的密码全系统没有任何入口能改。
   *
   * ⚠️ 必须验旧密码：光凭令牌就能改密码的话，令牌被人拿去 = 账号直接被夺走。
   */
  app.post("/auth/change-password", async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    // 限流按账号来，不按 IP：换 IP 就能继续猜旧密码的话，这道限流等于没有。
    if (checkRateLimit(rateLimitKey(auth.userId, "change-password"), 5, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "改密码太频繁了，请一分钟后再试");
      return;
    }

    // 和登录接口同样的理由：字段传成数字/数组时 .trim 不是函数会直接 500。
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const oldPassword = typeof raw.oldPassword === "string" ? raw.oldPassword : "";
    const newPassword = typeof raw.newPassword === "string" ? raw.newPassword : "";
    if (!oldPassword || !newPassword) {
      fail(res, 400, "BAD_REQUEST", "请填写旧密码和新密码");
      return;
    }

    const invalidReason = checkPasswordStrength(newPassword, oldPassword, auth.userId);
    if (invalidReason) {
      fail(res, 400, "BAD_REQUEST", invalidReason);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, status: true, passwordHash: true },
    });
    if (!user || user.status !== "active") {
      fail(res, 401, "UNAUTHORIZED", "账号状态异常，请重新登录");
      return;
    }
    if (!verifyPassword(oldPassword, user.passwordHash)) {
      // 故意不说「旧密码错」还是「账号不存在」之外的细节，但这里是本人操作，
      // 说清楚反而更好用，且已经有按账号限流兜底。
      logger.warn("改密码失败：旧密码不对", { 账号: auth.userId, 来源IP: getClientIp(req.headers) });
      fail(res, 400, "BAD_REQUEST", "旧密码不对");
      return;
    }

    await prisma.user.update({
      where: { id: auth.userId },
      data: { passwordHash: hashPassword(newPassword) },
    });

    logger.warn("改密码成功", { 账号: auth.userId, 角色: auth.role });
    ok(res, { changed: true });
  });
}
