import { describe, expect, test } from "bun:test";
import { patchWhamUsagePayload } from "../../src/codex/desktop-unblocker";

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
