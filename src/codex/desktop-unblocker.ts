import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export const DEFAULT_DESKTOP_UNBLOCKER_PORT = 8000;
export const DEFAULT_UPSTREAM_HOST = "chatgpt.com";
export const CODEX_API_BASE_URL_ENV = "CODEX_API_BASE_URL";

export interface UnblockerOptions {
  port?: number;
  upstreamHost?: string;
  host?: string;
}

/**
 * Patches the WHAM usage JSON payload to prevent ChatGPT Desktop Electron
 * from entering hardBlocked mode when weekly quota or credits reach zero.
 */
export function patchWhamUsagePayload(rawJson: string): string {
  try {
    const data = JSON.parse(rawJson);
    if (data.rate_limit) {
      data.rate_limit.allowed = true;
      data.rate_limit.limit_reached = false;
      if (data.rate_limit.primary_window) {
        data.rate_limit.primary_window.used_percent = 0;
      }
    }
    data.rate_limit_reached_type = null;
    data.rate_limit_upsell = null;
    if (data.credits) {
      data.credits.has_credits = true;
      data.credits.unlimited = true;
      data.credits.overage_limit_reached = false;
      data.credits.balance = "1000";
    }
    if (Array.isArray(data.additional_rate_limits)) {
      data.additional_rate_limits.forEach((limit: any) => {
        if (limit?.rate_limit) {
          limit.rate_limit.allowed = true;
          limit.rate_limit.limit_reached = false;
          if (limit.rate_limit.primary_window) {
            limit.rate_limit.primary_window.used_percent = 0;
          }
        }
      });
    }
    return JSON.stringify(data);
  } catch {
    return rawJson;
  }
}

/**
 * Creates a transparent reverse proxy server on 127.0.0.1:8000 (allowed natively by Desktop Electron)
 * that intercepts /backend-api/wham/usage and unblocks composer submit restrictions.
 */
export function createDesktopUnblockerServer(options?: UnblockerOptions): http.Server {
  const upstreamHost = options?.upstreamHost ?? DEFAULT_UPSTREAM_HOST;

  return http.createServer((clientReq, clientRes) => {
    const hostHeader = clientReq.headers.host || "127.0.0.1:8000";
    const url = new URL(clientReq.url || "/", `http://${hostHeader}`);
    const isWhamUsage = clientReq.method === "GET" && url.pathname.includes("/wham/usage");

    const headers = { ...clientReq.headers };
    headers.host = upstreamHost;

    const reqOptions: https.RequestOptions = {
      hostname: upstreamHost,
      port: 443,
      path: url.pathname + url.search,
      method: clientReq.method,
      headers,
    };

    const upstreamReq = https.request(reqOptions, (upstreamRes) => {
      if (isWhamUsage && upstreamRes.statusCode === 200) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          try {
            let buffer = Buffer.concat(chunks);
            const encoding = upstreamRes.headers["content-encoding"];
            if (encoding === "gzip") {
              buffer = zlib.gunzipSync(buffer);
            } else if (encoding === "br") {
              buffer = zlib.brotliDecompressSync(buffer);
            } else if (encoding === "deflate") {
              buffer = zlib.inflateSync(buffer);
            }

            const modified = patchWhamUsagePayload(buffer.toString("utf8"));
            const resHeaders = { ...upstreamRes.headers };
            delete resHeaders["content-encoding"];
            resHeaders["content-length"] = String(Buffer.byteLength(modified));
            resHeaders["content-type"] = "application/json";

            clientRes.writeHead(200, resHeaders);
            clientRes.end(modified);
          } catch {
            clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            clientRes.end(Buffer.concat(chunks));
          }
        });
        return;
      }

      // Transparent passthrough for all other endpoints (SSE streams, models, conversations)
      clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
        clientRes.end(`Bad Gateway: ${err.message}`);
      }
    });

    clientReq.pipe(upstreamReq);
  });
}
