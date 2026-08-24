import crypto from "node:crypto";

export interface AuthTokenPayload {
  userId: string;
  companyId: string;
  role: "admin" | "staff" | "client";
  userName: string;
  exp: number;
  /**
   * 密码指纹（2026-08-25 新增）。改了密码之后，旧令牌的这个值就对不上了，
   * 认证时会被拒掉 —— 不用等它自己 7 天后过期。
   * ⚠️ 这是拿 AUTH_SECRET 对密码哈希再算一次 HMAC 的前 16 位，
   *    反推不出密码，也反推不出密码哈希。
   * ⚠️ 老令牌里没有这个字段，那种一律放行（它们最多 7 天就自己过期了），
   *    否则这次上线会把所有人当场踢下线。
   */
  pv?: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padLen), "base64");
}

function tokenSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("FATAL: AUTH_SECRET environment variable is required but not set. Generate a random key: openssl rand -base64 48");
  }
  return secret;
}

/**
 * 由密码哈希算出的指纹，放进令牌用来判断「密码是不是换过了」。
 * 用 HMAC 而不是直接哈希：令牌内容客户端能看见，直接放密码哈希的摘要不合适。
 */
export function passwordFingerprint(passwordHash: string | null | undefined): string {
  return crypto
    .createHmac("sha256", tokenSecret())
    .update(`pw:${passwordHash ?? ""}`)
    .digest("base64url")
    .slice(0, 16);
}

export function signAuthToken(input: {
  userId: string;
  companyId: string;
  role: "admin" | "staff" | "client";
  userName: string;
  expiresInSeconds?: number;
  /** 传了就把密码指纹写进令牌；改密码后旧令牌立刻失效 */
  passwordHash?: string | null;
}): string {
  const header = { alg: "HS256", typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + (input.expiresInSeconds ?? 7 * 24 * 60 * 60);
  const payload: AuthTokenPayload = {
    userId: input.userId,
    companyId: input.companyId,
    role: input.role,
    userName: input.userName,
    exp,
    ...(input.passwordHash === undefined ? {} : { pv: passwordFingerprint(input.passwordHash) }),
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

/**
 * 令牌为什么没通过 —— 只用来写日志，不参与任何判断。
 * 2026-08-07 加：原来认证失败一条日志都不记，出问题只能靠猜
 * （连续两次"莫名其妙被踢回登录页"查不出原因）。
 * ⚠️ 只返回原因，绝不返回令牌内容本身。
 */
export function describeTokenFailure(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return "格式不对（不是三段）";
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return "格式不对（有空段）";
  try {
    const body = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
    const actualSig = base64UrlDecode(encodedSig);
    if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
      return "签名对不上（密钥变了 / 令牌被改过）";
    }
  } catch {
    return "签名校验时报错";
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Partial<AuthTokenPayload>;
    if (!payload?.userId || !payload.companyId || !payload.role || !payload.exp) return "内容缺字段";
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) return `已过期（过期于 ${new Date(payload.exp * 1000).toISOString()}，现在 ${new Date().toISOString()}）`;
    return "未知原因";
  } catch {
    return "内容解析失败";
  }
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return null;

  const body = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto.createHmac("sha256", tokenSecret()).update(body).digest();
  const actualSig = base64UrlDecode(encodedSig);
  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Partial<AuthTokenPayload>;
    if (!payload?.userId || !payload.companyId || !payload.role || !payload.exp) return null;
    if (payload.role !== "admin" && payload.role !== "staff" && payload.role !== "client") return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return {
      pv: payload.pv,
      userId: payload.userId,
      companyId: payload.companyId,
      role: payload.role,
      userName: payload.userName ?? "",
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
