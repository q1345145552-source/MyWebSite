import { getOptionalSession } from "../auth/auth-session";

/**
 * 统一去除 URL 末尾斜杠，避免拼接路径时出现双斜杠。
 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * 计算前端请求 API 的基础地址。
 * 浏览器端固定走相对路径（Next.js rewrites 代理），服务端渲染时才用环境变量。
 * 2026-08-31：删掉了「Render 域名自动推断」那段老逻辑（inferRenderApiUrlFromWindow /
 * isLoopbackApiUrl）—— 上面那行 `typeof window` 早把浏览器端截走了，
 * 推断函数在服务端永远返回 null，整段一次都执行不到，留着只会误导人。
 */
export function apiBaseUrl(): string {
  // 浏览器端用相对路径，走 Next.js rewrites 代理到 API
  if (typeof window !== "undefined") return "";
  const configured = (process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? "http://localhost:3001").trim();
  return trimTrailingSlash(configured);
}

/**
 * 生成需要鉴权的请求头。
 */
export function authHeaders(): Record<string, string> {
  const session = getOptionalSession();
  if (!session || !session.token) {
    return {};
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

/** 读令牌自带的到期时间（秒）。读不出来返回 null。⚠️ 不返回令牌内容。 */
function readTokenExp(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const body = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof body?.exp === "number" ? body.exp : null;
  } catch {
    return null;
  }
}

function goToLogin() {
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login?expired=1";
  }
}

/**
 * 连续多少次「令牌看着没过期、后端却不认」就还是把人踢去重新登录。
 * 保险丝：万一后端换了签名密钥，所有人的令牌都会变成「没过期但不被认」，
 * 这时候如果永远不跳登录页，用户就只能一直看报错、连重新登录的入口都摸不到。
 */
const MAX_UNEXPLAINED_401 = 3;
let unexplained401Count = 0;

/**
 * 统一解析后端响应并在失败时抛出可读错误。
 *
 * 401 的处理（2026-08-07 改）：
 * 原来只要任何一个后台请求返回 401，就立刻清登录、跳登录页 ——
 * 员工正在填的东西全没了。而且实际发生过两次「令牌明明是好的却被踢」，
 * 查不出原因（详见下面的 console 日志）。
 * 现在只有**本地令牌确实已经过期**（或压根没登录）才跳登录页；
 * 令牌看着还有效的，只报错、不踢人，让用户能把手上的活保住。
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    /**
     * ⚠️ 登录接口自己也用 401 表示「账号或密码不对」，不能走下面那套「登录过期」的逻辑。
     * 原来会走 —— 用户在登录页把密码打错，看到的提示是
     * 「登录失败：登录已过期，请重新登录」。人根本还没登录过，哪来的过期，
     * 会让人以为是系统坏了而不是自己打错字（2026-08-11 以用户视角走查时发现）。
     */
    if (response.url.includes("/auth/login")) {
      throw new Error("账号或密码不对，请重新输入");
    }
    const session = typeof window !== "undefined" ? getOptionalSession() : null;
    const exp = readTokenExp(session?.token);
    const nowSec = Math.floor(Date.now() / 1000);
    // 没登录信息、或令牌读不出到期时间、或确实过期了 → 才算「真的该重新登录」
    const reallyExpired = !session?.token || exp == null || nowSec >= exp;

    if (typeof window !== "undefined") {
      // ⚠️ 只记有没有、到期时间，绝不打印令牌本身
      console.warn("[接口返回 401]", {
        接口: response.url,
        本地有没有登录信息: !!session,
        角色: session?.role ?? "无",
        令牌到期: exp == null ? "读不出来" : `${new Date(exp * 1000).toLocaleString()}（${nowSec >= exp ? "已过期" : `还剩 ${Math.round((exp - nowSec) / 60)} 分钟`}）`,
        处理: reallyExpired ? "确实过期，跳登录页" : `令牌还有效，不踢人（连续第 ${unexplained401Count + 1} 次，满 ${MAX_UNEXPLAINED_401} 次才跳）`,
      });
    }

    if (reallyExpired) {
      unexplained401Count = 0;
      goToLogin();
      throw new Error("登录已过期，请重新登录");
    }

    unexplained401Count += 1;
    if (unexplained401Count >= MAX_UNEXPLAINED_401) {
      unexplained401Count = 0;
      goToLogin();
      throw new Error("登录状态异常，请重新登录");
    }
    throw new Error("这一步没能通过登录校验，请重试一次；反复出现请重新登录（你填的内容还在）");
  }
  // 有一次正常响应就说明登录是好的，把连续计数清零
  unexplained401Count = 0;
  const text = await response.text();
  let payload: { code?: string; message?: string; data?: T } | null = null;
  try {
    payload = text ? (JSON.parse(text) as { code?: string; message?: string; data?: T }) : null;
  } catch {
    if (!response.ok) throw new Error(`请求失败 ${response.status}${text ? `: ${text.slice(0, 150)}` : ""}`);
    throw new Error("invalid response");
  }
  if (!response.ok || payload?.code !== "OK") {
    throw new Error(payload?.message ?? "request failed");
  }
  return payload.data as T;
}

/**
 * 统一 API 请求：fetch + 超时 + 429重试 + parseApiResponse + 错误兜底。
 * 所有 API 调用必须使用此包装，禁止裸调 fetch。
 */
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let lastError: Error | null = null;
  // 429 限流自动重试最多 2 次，间隔 2s / 4s
  for (let attempt = 0; attempt < 3; attempt++) {
    // 【审查问题 9】超时控制器改成每次请求各自一个：
    // 原来 3 次重试共用一个 30 秒计时器，等待的 2s+4s 也算在里面，
    // 最后一次实际只剩不到 24 秒；而且一旦 abort 过，signal 就报废了。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 单次请求 30 秒超时
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...authHeaders(),
          ...(options.headers as Record<string, string> || {}),
        },
      });

      // 429 限流 → 等待后重试
      if (response.status === 429 && attempt < 2) {
        clearTimeout(timeout);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }

      // 【审查问题 4】5xx 只提示、不重试。
      // 原来这里 throw 会被下面的 catch 接住再 continue，等于服务器已经扛不住了
      // 前端还给它发 3 倍请求。直接跳出循环。
      if (response.status >= 500) {
        lastError = new Error("服务器繁忙，请稍后重试");
        break;
      }

      return await parseApiResponse<T>(response);
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // 超时
      if (e?.name === "AbortError") {
        lastError = new Error("请求超时，请检查网络后重试");
        break;
      }
      // 网络断开
      if (e instanceof TypeError && (e.message.includes("fetch") || e.message.includes("network"))) {
        lastError = new Error("网络连接异常，请检查网络后重试");
        break;
      }
      // 其余错误（含后端返回的业务错误）不重试，直接抛给调用方
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("请求失败");
}
