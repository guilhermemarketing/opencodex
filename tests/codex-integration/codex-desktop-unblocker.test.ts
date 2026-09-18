import { describe, expect, test } from "bun:test";
import {
  createDesktopUnblockerServer,
  patchWhamUsagePayload,
  resolveDesktopUnblockerTarget,
} from "../../src/codex/desktop-unblocker";

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
