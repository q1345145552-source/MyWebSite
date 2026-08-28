import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { describeTokenFailure, verifyAuthToken } from "./modules/auth/token";
import { isSessionStillValid } from "./modules/auth/session-guard";
import { logger } from "./modules/core/logger";
import { isBusinessError } from "./modules/core/business-error";
import { fail } from "./modules/core/http-utils";

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  body?: unknown;
  headers: IncomingMessage["headers"];
  auth?: {
    userId: string;
    companyId: string;
    role: "admin" | "staff" | "client";
    name: string;
  };
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: unknown): void;
  /**
   * 这一次请求的编号（`req_xxx`），由请求管线在最外层塞进来。
   * `ok()` / `fail()` 会把它放进响应体 —— 契约（docs/api-contract.md 第 2、3 节）
   * 要求成功和失败都带 requestId，之前一直是空的。
   * 客户截图报错时，靠它就能在日志里定位到那一次请求。
   */
  requestId?: string;
}

type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

export interface MinimalHttpApp {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  listen(port: number, callback?: () => void): void;
}

type RouteTable = Record<string, Handler>;

/**
 * 从请求头里解出登录身份。
 * 2026-08-07：认证失败原来一声不吭，前端拿到 401 就把用户踢回登录页，
 * 排查时完全没有线索。这里补上日志（只记原因和路径，绝不记令牌内容）。
 */
async function parseAuth(headers: IncomingMessage["headers"], path?: string): Promise<HttpRequest["auth"]> {
  const authHeader = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    if (authHeader) {
      logger.warn("认证失败：Authorization 头格式不对", { path, 头长度: authHeader.length });
    }
    return undefined;
  }
  const payload = verifyAuthToken(match[1].trim());
  if (!payload) {
    logger.warn("认证失败：令牌没通过", { path, 原因: describeTokenFailure(match[1].trim()) });
    return undefined;
  }
  /**
   * ⚠️ 签名对、没过期，**还不够**（2026-08-25 新增）。
   * 账号可能已经被封禁、或者密码已经改过 —— 那两种情况下这张令牌必须当场作废，
   * 不能让它继续用满 7 天。详见 session-guard.ts。
   */
  const live = await isSessionStillValid(payload);
  if (!live.ok) {
    logger.warn("认证失败：登录状态已失效", { path, 用户: payload.userId, 原因: live.reason });
    return undefined;
  }
  return {
    userId: payload.userId,
    companyId: payload.companyId,
    role: payload.role,
    name: payload.userName ?? "",
  };
}

/**
 * 每次请求一个编号。契约（docs/api-contract.md）要求成功和失败都带 `requestId`，
 * 之前一直没生成过。同时写进 `X-Request-Id` 响应头 ——
 * 客户截图报错时，从截图或浏览器控制台就能拿到它，直接去日志里定位那一次请求。
 */
function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createJsonResponse(rawRes: ServerResponse): HttpResponse {
  let statusCode = 200;
  const requestId = newRequestId();
  return {
    requestId,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      rawRes.statusCode = statusCode;
      rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
      rawRes.setHeader("X-Request-Id", requestId);
      rawRes.end(JSON.stringify(payload));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const maxBytes = 20 * 1024 * 1024; // 20MB 限制
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createApp(): MinimalHttpApp {
  const getRoutes: RouteTable = {};
  const postRoutes: RouteTable = {};
  const deleteRoutes: RouteTable = {};

  const app: MinimalHttpApp = {
    get(path, handler) {
      getRoutes[path] = handler;
    },
    post(path, handler) {
      postRoutes[path] = handler;
    },
    delete(path, handler) {
      deleteRoutes[path] = handler;
    },
    listen(port, callback) {
      // 【审查问题 1】原来整段逻辑直接写在 createServer 的回调里，
      // 而 try/catch 只包住了最后调 handler 的那一句。
      // 前面的 await readJsonBody() 一抛错（客户上传照片中途断网就会）
      // 就是一个没人接的 Promise rejection —— Node 会直接结束进程，整个 API 挂掉。
      // 现在把整段抽成函数，在外面统一兜一层。
      const handleRequest = async (rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> => {
        const allowedOrigin = process.env.CORS_ORIGIN?.trim() || (process.env.NODE_ENV === "production" ? "" : "*");
        if (allowedOrigin) {
          rawRes.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        }
        rawRes.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        rawRes.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type,x-role,x-user-id,x-company-id,Authorization",
        );
        rawRes.setHeader("Vary", "Origin");

        if ((rawReq.method ?? "").toUpperCase() === "OPTIONS") {
          rawRes.statusCode = 204;
          rawRes.end();
          return;
        }

        const method = rawReq.method?.toUpperCase() ?? "GET";
        const requestUrl = new URL(rawReq.url ?? "/", "http://localhost");
        const path = requestUrl.pathname;
        const query: Record<string, string | undefined> = {};
        requestUrl.searchParams.forEach((value, key) => {
          query[key] = value;
        });

        // 静态文件服务：/images/* → 直接从磁盘读取
        if (method === "GET" && path.startsWith("/images/")) {
          const fs = await import("node:fs");
          const pathModule = await import("node:path");
          const imagesDir = process.env.IMAGES_DIR || "./data/images";
          const filePath = pathModule.default.join(imagesDir, pathModule.default.basename(path));
          if (!fs.default.existsSync(filePath)) {
            rawRes.statusCode = 404;
            rawRes.end("Not Found");
            return;
          }
          const ext = pathModule.default.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
          };
          rawRes.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
          rawRes.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          const buf = fs.default.readFileSync(filePath);
          rawRes.end(buf);
          return;
        }

        const routeTable =
          method === "POST" ? postRoutes : method === "DELETE" ? deleteRoutes : getRoutes;
        const handler = routeTable[path];
        const res = createJsonResponse(rawRes);
        if (!handler) {
          // 这条以前也是自己拼的，同样少了 errors / requestId / timestamp
          fail(res, 404, "NOT_FOUND", `Route not found: ${method} ${path}`);
          return;
        }

        const req: HttpRequest = {
          method,
          path,
          query,
          headers: rawReq.headers,
          body: method === "POST" || method === "DELETE" ? await readJsonBody(rawReq) : undefined,
          auth: await parseAuth(rawReq.headers, path),
        };

        try {
          await handler(req, res);
        } catch (error) {
          /**
           * ⚠️ 业务错误统一在这里转成 400，别让它变成 500（2026-08-27 新增）。
           *
           * 「整柜已取消不许收钱」那几道闸门是抛异常实现的。原来靠每个路由自己
           * try/catch，结果四个管理员接口全忘了接 —— 员工看到「服务器繁忙」，
           * 完全不知道是柜被取消了。放在最外层就忘不了，以后再加闸门也自动生效。
           */
          /**
           * ⚠️ 一律走 `fail()`，不要自己拼响应体（2026-08-28 改）。
           * 原来这两处直接 `res.json({ code, message })`，少了契约要求的
           * `errors` / `requestId` / `timestamp` —— 同一个系统里两种错误格式，
           * 前端要写两套解析，客户报错时也没有编号可查。
           */
          if (isBusinessError(error)) {
            logger.warn("业务规则拦截", { path, requestId: res.requestId, 原因: error.message });
            fail(res, error.httpStatus, error.code, error.message);
            return;
          }
          logger.error("unhandled error", {
            path,
            requestId: res.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          const isProduction = process.env.NODE_ENV === "production";
          const message = isProduction
            ? "Internal server error"
            : error instanceof Error ? error.message : "internal error";
          fail(res, 500, "INTERNAL_ERROR", message);
        }
      };

      const server = createServer((rawReq, rawRes) => {
        void handleRequest(rawReq, rawRes).catch((error: unknown) => {
          logger.error("request pipeline error", {
            method: rawReq.method,
            url: rawReq.url,
            error: error instanceof Error ? error.message : String(error),
          });
          // 静态图片那条分支可能已经开始往外写了，这时候不能再写响应头
          if (rawRes.headersSent) {
            if (!rawRes.writableEnded) rawRes.end();
            return;
          }
          rawRes.statusCode = 500;
          rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
          rawRes.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "Internal server error" }));
        });
      });

      const host = process.env.BIND_HOST?.trim() || "0.0.0.0";
      server.listen(port, host, callback);
    },
  };

  return app;
}
