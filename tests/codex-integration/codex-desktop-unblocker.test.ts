import { describe, expect, test } from "bun:test";
import {
  createDesktopUnblockerServer,
  patchAccountReadRpcPayload,
  patchInitializeRpcPayload,
  patchRateLimitsRpcPayload,
  patchWhamUsagePayload,
  resolveDesktopUnblockerTarget,
} from "../../src/codex/desktop-unblocker";
import {
  formatDesktopUnblockerStatus,
  generateCodexShimScript,
} from "../../src/cli/desktop-unblocker";

describe("desktop unblocker payload patching", () => {
  test("overrides depleted rate limit and hardBlocked states to unblocked", () => {
    const depleted = JSON.stringify({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100 },
      },
      rate_limit_reached_type: "rate_limit_reached",
      rate_limit_upsell: { banner_type: "luna_reserve" },
      credits: {
        has_credits: false,
        unlimited: false,
        balance: "0",
      },
      additional_rate_limits: [
        {
          limit_name: "gpt-reserve",
          rate_limit: { allowed: false, limit_reached: true },
        },
      ],
    });

    const patched = JSON.parse(patchWhamUsagePayload(depleted));

    expect(patched.rate_limit.allowed).toBe(true);
    expect(patched.rate_limit.limit_reached).toBe(false);
    expect(patched.rate_limit.primary_window.used_percent).toBe(0);
    expect(patched.rate_limit_reached_type).toBe(null);
    expect(patched.rate_limit_upsell).toBe(null);
    expect(patched.credits.has_credits).toBe(true);
    expect(patched.credits.unlimited).toBe(true);
    expect(patched.credits.balance).toBe("1000");
    expect(patched.additional_rate_limits[0].rate_limit.allowed).toBe(true);
  });

  test("handles malformed JSON gracefully", () => {
    const invalid = "not-json";
    expect(patchWhamUsagePayload(invalid)).toBe(invalid);
  });
});

describe("desktop unblocker stdio JSON-RPC patching", () => {
  test("patches account/rateLimits/read to force ordinaryUsageAllowed: true and clear upsell", () => {
    const depletedRpc = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: {
        ordinaryUsageAllowed: false,
        rateLimits: {
          primary: { usedPercent: 100 },
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
        rateLimitsByLimitId: {
          "codex-default": {
            primary: { usedPercent: 100 },
            rateLimitReachedType: "hardBlocked",
          },
        },
        rateLimitUpsell: { type: "hardBlocked" },
      },
    });

    const patched = JSON.parse(patchRateLimitsRpcPayload(depletedRpc));
    expect(patched.result.ordinaryUsageAllowed).toBe(true);
    expect(patched.result.rateLimits.primary.usedPercent).toBe(0);
    expect(patched.result.rateLimits.credits.hasCredits).toBe(true);
    expect(patched.result.rateLimits.credits.unlimited).toBe(true);
    expect(patched.result.rateLimits.credits.balance).toBe("1000");
    expect(patched.result.rateLimitsByLimitId["codex-default"].primary.usedPercent).toBe(0);
    expect(patched.result.rateLimitsByLimitId["codex-default"].rateLimitReachedType).toBeNull();
    expect(patched.result.rateLimitUpsell).toBeNull();
  });

  test("strips workspaceRouting from account/read to keep loopback routing active", () => {
    const accountReadRpc = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        account: { id: "acc-123" },
        workspaceRouting: {
          backendUrl: "https://chatgpt.com/backend-api",
        },
      },
    });

    const patched = JSON.parse(patchAccountReadRpcPayload(accountReadRpc));
    expect(patched.result.account.id).toBe("acc-123");
    expect(patched.result.workspaceRouting).toBeUndefined();
  });

  test("spoofs userAgent in initialize response to legacy compatible version", () => {
    const initRpc = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex/0.155.0-alpha.9.2 (darwin; arm64)",
      },
    });

    const patched = JSON.parse(patchInitializeRpcPayload(initRpc, "0.155.0-alpha.2.6"));
    expect(patched.result.userAgent).toBe("codex/0.155.0-alpha.2.6 (darwin; arm64)");
  });

  test("generateCodexShimScript outputs valid executable JS template", () => {
    const script = generateCodexShimScript();
    expect(script).toContain("#!/usr/bin/env node");
    expect(script).toContain("REAL_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'");
    expect(script).toContain("delete msg.result.workspaceRouting;");
    expect(script).toContain("msg.result.ordinaryUsageAllowed = true;");
  });

  test("formatDesktopUnblockerStatus includes CODEX_CLI_PATH", () => {
    const status = formatDesktopUnblockerStatus(true, "http://localhost:8000/backend-api", "/path/to/shim");
    expect(status).toContain("active (port 8000)");
    expect(status).toContain("CODEX_API_BASE_URL: set (http://localhost:8000/backend-api)");
    expect(status).toContain("CODEX_CLI_PATH: set (/path/to/shim)");
  });
});

describe("desktop unblocker request target", () => {
  test("resolves origin-form targets against the fixed loopback base", () => {
    expect(resolveDesktopUnblockerTarget("/backend-api/wham/usage")?.pathname).toBe(
      "/backend-api/wham/usage",
    );
    expect(resolveDesktopUnblockerTarget("/backend-api/wham/usage?x=1")?.search).toBe("?x=1");
    expect(resolveDesktopUnblockerTarget(undefined)?.pathname).toBe("/");
  });

  test("refuses targets that leave the loopback origin instead of throwing", () => {
    // The malformed cases are the ones that made `new URL(..., `http://${host}`)` throw out of
    // the request callback; the protocol-relative case is the one a client-supplied Host could
    // have smuggled into the parsed host.
    expect(resolveDesktopUnblockerTarget("//evil.example/backend-api/wham/usage")).toBeNull();
    expect(resolveDesktopUnblockerTarget("http://evil.example/backend-api/wham/usage")).toBeNull();
    expect(resolveDesktopUnblockerTarget("http://[")).toBeNull();
  });
});

describe("desktop unblocker upstream allowlist", () => {
  test("refuses an untrusted upstream host instead of forwarding credentials to it", () => {
    expect(() => createDesktopUnblockerServer({ upstreamHost: "evil.example" })).toThrow(
      /untrusted upstream host/,
    );
  });

  test("accepts the trusted upstream host, explicitly and by default", () => {
    expect(() => createDesktopUnblockerServer()).not.toThrow();
    expect(() => createDesktopUnblockerServer({ upstreamHost: "chatgpt.com" })).not.toThrow();
  });
});
