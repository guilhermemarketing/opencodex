import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export const DEFAULT_DESKTOP_UNBLOCKER_PORT = 8000;
export const DEFAULT_UPSTREAM_HOST = "chatgpt.com";
export const CODEX_API_BASE_URL_ENV = "CODEX_API_BASE_URL";

/**
 * Absolute base used only to parse the client request target. The `Host` header is client input,
 * so it cannot supply this base: `Host: :` makes `new URL` throw, and that exception would escape
 * the request callback and take the listener down with it.
 */
const REQUEST_TARGET_BASE = "http://127.0.0.1";

/**
 * Destinations this proxy may forward to. Every forwarded request carries the caller's Desktop
 * credentials (`authorization` plus the account headers), so the destination is an allowlist
 * rather than a free option: an untrusted `upstreamHost` would receive those credentials.
 */
const TRUSTED_UPSTREAM_HOSTS: ReadonlySet<string> = new Set([DEFAULT_UPSTREAM_HOST]);

/**
 * Framing headers that describe the buffered upstream body. The rewritten usage body is sized
 * locally, so forwarding `transfer-encoding` next to the new `content-length` is invalid framing
 * for the response the client is asked to read.
 */
const BUFFERED_RESPONSE_FRAMING_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

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
 * Resolve a client request target against the fixed loopback base. Returns `null` when the target
 * cannot be parsed or does not resolve to the loopback origin — an absolute-form or
 * protocol-relative target such as `//host/path` — so the caller answers 400 instead of forwarding it.
 */
export function resolveDesktopUnblockerTarget(requestTarget: string | undefined): URL | null {
  let url: URL;
  try {
    url = new URL(requestTarget || "/", REQUEST_TARGET_BASE);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.host !== "127.0.0.1") return null;
  return url;
}

/**
 * Creates a transparent reverse proxy server on 127.0.0.1:8000 (allowed natively by Desktop Electron)
 * that intercepts /backend-api/wham/usage and unblocks composer submit restrictions.
 */
export function createDesktopUnblockerServer(options?: UnblockerOptions): http.Server {
  const upstreamHost = options?.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  if (!TRUSTED_UPSTREAM_HOSTS.has(upstreamHost)) {
    throw new Error(
      `Refusing to forward Desktop credentials to untrusted upstream host "${upstreamHost}" ` +
        `(allowed: ${[...TRUSTED_UPSTREAM_HOSTS].join(", ")})`,
    );
  }

  return http.createServer((clientReq, clientRes) => {
    const url = resolveDesktopUnblockerTarget(clientReq.url);
    if (!url) {
      clientRes.writeHead(400, { "Content-Type": "text/plain" });
      clientRes.end("Bad Request: malformed request target");
      return;
    }
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
            for (const header of BUFFERED_RESPONSE_FRAMING_HEADERS) delete resHeaders[header];
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
