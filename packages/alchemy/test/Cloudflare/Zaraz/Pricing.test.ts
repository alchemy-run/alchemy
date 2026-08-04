import { ZarazPricing } from "@/Cloudflare/Zaraz/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("ZarazPricing", () => {
  test("bills nothing at zero usage and does not require the Workers Paid plan", () => {
    expect(ZarazPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(ZarazPricing.floorMonthlyUsd({ zone: "example.com" })).toBe(0);
    expect(ZarazPricing.requiresPaidPlan).toBe(false);
  });

  test("exposes the published per-event rate with its free allotment", () => {
    const rates = ZarazPricing.rates({ zone: "example.com" });
    expect(rates).toHaveLength(1);
    expect(rates[0].label).toBe("Zaraz events");
    expect(rates[0].perUnit).toBe(5);
    expect(rates[0].unit).toBe("million events");
    expect(rates[0].freeIncluded).toBe("1M/mo free (per account)");
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. Nothing in ConfigProps changes
  // the per-event rate, so the rate must be identical either way.
  describe("unresolved plan-time Outputs", () => {
    test("an Output zone leaves the rate unchanged", () => {
      expect(ZarazPricing.rates({ zone: asOutput("example.com") })).toEqual(
        ZarazPricing.rates(undefined),
      );
    });

    test("a whole-props Output leaves the rate unchanged", () => {
      expect(
        ZarazPricing.rates(asOutput({ zone: "example.com", dataLayer: true })),
      ).toEqual(ZarazPricing.rates(undefined));
      expect(
        ZarazPricing.floorMonthlyUsd(asOutput({ zone: "example.com" })),
      ).toBe(0);
    });
  });
});
