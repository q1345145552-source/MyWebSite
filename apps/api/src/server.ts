import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { describeTokenFailure, verifyAuthToken } from "./modules/auth/token";
import { logger } from "./modules/core/logger";

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
function parseAuth(headers: IncomingMessage["headers"], path?: string): HttpRequest["auth"] {
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
  return {
    userId: payload.userId,
    companyId: payload.companyId,
    role: payload.role,
    name: payload.userName ?? "",
  };
}

function createJsonResponse(rawRes: ServerResponse): HttpResponse {
  let statusCode = 200;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      rawRes.statusCode = statusCode;
      rawRes.setHeader("Content-Type", "application/json; charset=utf-8");
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
          res.status(404).json({
            code: "NOT_FOUND",
            message: `Route not found: ${method} ${path}`,
          });
          return;
        }

        const req: HttpRequest = {
          method,
          path,
          query,
          headers: rawReq.headers,
          body: method === "POST" || method === "DELETE" ? await readJsonBody(rawReq) : undefined,
          auth: parseAuth(rawReq.headers, path),
        };

        try {
          await handler(req, res);
        } catch (error) {
          logger.error("unhandled error", { error: error instanceof Error ? error.message : String(error) });
          const isProduction = process.env.NODE_ENV === "production";
          const message = isProduction
            ? "Internal server error"
            : error instanceof Error ? error.message : "internal error";
          res.status(500).json({
            code: "INTERNAL_ERROR",
            message,
          });
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
