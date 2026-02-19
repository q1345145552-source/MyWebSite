import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

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

function parseAuth(headers: IncomingMessage["headers"]): HttpRequest["auth"] {
  const userId = typeof headers["x-user-id"] === "string" ? headers["x-user-id"] : "u_client_001";
  const companyId =
    typeof headers["x-company-id"] === "string" ? headers["x-company-id"] : "c_001";
  const roleHeader = typeof headers["x-role"] === "string" ? headers["x-role"] : "client";
  const role = roleHeader === "admin" || roleHeader === "staff" ? roleHeader : "client";
  return { userId, companyId, role };
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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
      const server = createServer(async (rawReq, rawRes) => {
        rawRes.setHeader("Access-Control-Allow-Origin", "*");
        rawRes.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        rawRes.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type,x-role,x-user-id,x-company-id,Authorization",
        );

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
          auth: parseAuth(rawReq.headers),
        };

        try {
          await handler(req, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : "internal error";
          res.status(500).json({
            code: "INTERNAL_ERROR",
            message,
          });
        }
      });

      server.listen(port, callback);
    },
  };

  return app;
}
