import path from "node:path";
import type { NextConfig } from "next";

/**
 * 转发目标。默认 http://api:3001 是 Docker Compose 里的服务名，
 * 线上不设这个变量就跟以前完全一样。
 * 本地开发没有叫 api 的主机，在 apps/web/.env.local 里设成
 * http://127.0.0.1:3001 即可，不用改 hosts。
 */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET?.trim() || "http://api:3001";

const nextConfig: NextConfig = {
  // dev:public listens on 0.0.0.0; the embedded browser uses this loopback origin.
  // Explicit development-only allowance; API rewrites and production headers stay unchanged.
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: `${API_PROXY_TARGET}/auth/:path*` },
      { source: "/admin/:path*", destination: `${API_PROXY_TARGET}/admin/:path*` },
      { source: "/staff/:path*", destination: `${API_PROXY_TARGET}/staff/:path*` },
      { source: "/client/:path*", destination: `${API_PROXY_TARGET}/client/:path*` },
      { source: "/images/:path*", destination: `${API_PROXY_TARGET}/images/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; font-src 'self' data:;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
