import { CacheReservePricing } from "@/Cloudflare/Cache/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("CacheReservePricing", () => {
  test("bills nothing at zero usage and does not require the Workers Paid plan", () => {
    expect(CacheReservePricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(CacheReservePricing.floorMonthlyUsd({ zoneId: "zone" })).toBe(0);
    expect(CacheReservePricing.requiresPaidPlan).toBe(false);
  });

  test("exposes storage plus Class A/B operations at the published rates", () => {
    const rates = CacheReservePricing.rates({ zoneId: "zone" });
    expect(rates.map((r) => r.label)).toEqual([
      "Cache Reserve storage",
      "Cache Reserve Class A operations (writes)",
      "Cache Reserve Class B operations (reads)",
    ]);
    expect(rates[0].perUnit).toBe(0.015);
    expect(rates[0].unit).toBe("GB-month");
    expect(rates[1].perUnit).toBe(4.5);
    expect(rates[1].unit).toBe("million operations");
    expect(rates[2].perUnit).toBe(0.36);
    expect(rates[2].unit).toBe("million operations");
  });

  test("absent `enabled` reads as the enabled default — no qualifier", () => {
    expect(CacheReservePricing.rates(undefined)[0].label).toBe(
      "Cache Reserve storage",
    );
    expect(
      CacheReservePricing.rates({ zoneId: "zone", enabled: true })[0].label,
    ).toBe("Cache Reserve storage");
  });

  test("disabled says stored data keeps billing until cleared", () => {
    const rates = CacheReservePricing.rates({
      zoneId: "zone",
      enabled: false,
    });
    expect(rates[0].label).toBe(
      "Cache Reserve storage (disabled — data already in reserve bills until cleared)",
    );
    // Disabling stops new writes, it does not change the rate itself.
    expect(rates[0].perUnit).toBe(0.015);
    expect(rates[2].label).toContain("bills until cleared");
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs.
  describe("unresolved plan-time Outputs", () => {
    test("an Output `enabled` shows the enabled rates and says so", () => {
      const rates = CacheReservePricing.rates({
        zoneId: "zone",
        enabled: asOutput(false),
      });
      expect(rates[0].label).toBe(
        "Cache Reserve storage (enabled state unresolved at plan time — enabled rates shown)",
      );
      expect(rates[0].perUnit).toBe(0.015);
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = CacheReservePricing.rates(
        asOutput({ zoneId: "zone", enabled: false }),
      );
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates.every((r) => r.perUnit > 0)).toBe(true);
    });

    test("an unresolved zoneId does not affect the rates", () => {
      const rates = CacheReservePricing.rates({ zoneId: asOutput("zone") });
      expect(rates[0].label).toBe("Cache Reserve storage");
    });
  });
});
