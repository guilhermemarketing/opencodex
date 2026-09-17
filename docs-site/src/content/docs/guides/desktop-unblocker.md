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
- **Usage Override:** For `GET /backend-api/wham/usage`, it patches `rate_limit.allowed: true` and `credits.has_credits: true`.
- **Result:** Desktop removes the upsell modal and keeps the composer Send button active. Messages route smoothly through opencodex to configured third-party models.
