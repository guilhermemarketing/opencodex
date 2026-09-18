---
title: ChatGPT Desktop Unblocker (Luna Reserve & Quota Lockout)
description: Bypassing the Desktop client hard composer lockout and model picker collapse when allowance is zero.
---

When the ChatGPT weekly allowance and Luna Reserve capacity are exhausted, the ChatGPT Desktop Electron app enters a `hardBlocked` client state by evaluating `/backend-api/wham/usage`:
- The model picker dropdown collapses, forcefully setting the conversation to `gpt-reserve`.
- The composer Send button (`aria-label="Enviar"` / `Send`) is disabled (`submitDisabled: true`).
- A blocking modal banner (*"You've run out of usage for Codex..."*) prevents message dispatch.

### Architecture

In ChatGPT Desktop's Electron main process (`main-*.js`):
1. The app reads `process.env.CODEX_API_BASE_URL` to route `/backend-api` calls.
2. `isDesktopAuthAllowedUrl` explicitly allows `localhost:8000` (and `localhost`) to attach native Bearer tokens and headers.

### Unblocker Service

The unblocker operates a loopback reverse proxy on `127.0.0.1:8000`:
- **Passthrough:** All conversations, streaming SSE tokens, and standard endpoints forward transparently to `https://chatgpt.com`.
- **Trusted destination:** `chatgpt.com` is an allowlist, not a default. `createDesktopUnblockerServer` refuses to start for any other upstream host, because every forwarded request carries the caller's Desktop credentials (`authorization` plus the account headers). A request target that does not resolve to the loopback origin is answered with `400` instead of being forwarded.
- **Usage Override:** For `GET /backend-api/wham/usage`, it patches `rate_limit.allowed: true` and `credits.has_credits: true`.
- **Result:** Desktop stops reading its own lockout state, so the upsell modal stays closed and the composer Send button stays enabled. The proxy rewrites the usage payload only: it adds no provider quota, every other Desktop request still goes to `https://chatgpt.com`, and it does not decide which models opencodex serves — that is the [Codex Integration](/guides/codex-integration/) and its [routed models during Codex reserve mode](/guides/codex-integration/#routed-models-during-codex-reserve-mode) section, not this listener.
