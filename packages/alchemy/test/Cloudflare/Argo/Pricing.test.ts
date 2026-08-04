import { ArgoSmartRoutingPricing } from "@/Cloudflare/Argo/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("ArgoSmartRoutingPricing", () => {
  describe("floorMonthlyUsd — Argo bills at zero usage", () => {
    test("costs the flat $5/mo subscription with no props", () => {
      expect(ArgoSmartRoutingPricing.floorMonthlyUsd(undefined)).toBe(5);
    });

    test("costs $5/mo when enabled is left at its default", () => {
      expect(ArgoSmartRoutingPricing.floorMonthlyUsd({ zoneId: "zone" })).toBe(
        5,
      );
    });

    test("costs $5/mo when explicitly enabled", () => {
      expect(
        ArgoSmartRoutingPricing.floorMonthlyUsd({
          zoneId: "zone",
          enabled: true,
        }),
      ).toBe(5);
    });

    test("costs nothing when Smart Routing is switched off", () => {
      expect(
        ArgoSmartRoutingPricing.floorMonthlyUsd({
          zoneId: "zone",
          enabled: false,
        }),
      ).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("Argo is its own add-on, not the Workers Paid plan", () => {
      expect(ArgoSmartRoutingPricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates", () => {
    test("exposes the $0.10/GB data-transfer rate", () => {
      const rates = ArgoSmartRoutingPricing.rates(undefined);
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Argo Smart Routing data transfer");
      expect(rates[0].perUnit).toBe(0.1);
      expect(rates[0].unit).toBe(
        "GB transferred between Cloudflare and origin",
      );
      // The $5/mo subscription bundles the first GB — Cloudflare's billing
      // docs: "Metered per GB transferred between Cloudflare and your
      // origin. First 1 GB included."
      expect(rates[0].freeIncluded).toBe("1 GB/mo");
    });

    test("keeps the same rate when explicitly enabled", () => {
      const rates = ArgoSmartRoutingPricing.rates({
        zoneId: "zone",
        enabled: true,
      });
      expect(rates[0].label).toBe("Argo Smart Routing data transfer");
      expect(rates[0].perUnit).toBe(0.1);
    });

    test("says so when Smart Routing is switched off", () => {
      const rates = ArgoSmartRoutingPricing.rates({
        zoneId: "zone",
        enabled: false,
      });
      expect(rates[0].label).toBe(
        "Argo Smart Routing data transfer (disabled on this zone)",
      );
      expect(rates[0].perUnit).toBe(0.1);
      // The published allotment is a property of the rate, not of whether
      // this particular zone happens to have Argo switched on.
      expect(rates[0].freeIncluded).toBe("1 GB/mo");
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never be silently mis-priced.
  describe("unresolved plan-time Outputs", () => {
    test("an Output enabled prices as enabled and says so", () => {
      const props = { zoneId: "zone", enabled: asOutput(false) };
      const rates = ArgoSmartRoutingPricing.rates(props);
      expect(rates[0].label).toBe(
        "Argo Smart Routing data transfer (enabled unresolved at plan time — enabled rates shown)",
      );
      // Falls back to the subscribed floor — NOT $0 (the pre-guard
      // behavior: an Output object compared against `false` never matched
      // and would have silently priced the zone as free).
      expect(ArgoSmartRoutingPricing.floorMonthlyUsd(props)).toBe(5);
    });

    test("an Output zoneId does not disturb the price", () => {
      const props = { zoneId: asOutput("zone") };
      expect(ArgoSmartRoutingPricing.floorMonthlyUsd(props)).toBe(5);
      expect(ArgoSmartRoutingPricing.rates(props)[0].label).toBe(
        "Argo Smart Routing data transfer",
      );
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const props = asOutput({ zoneId: "zone", enabled: false });
      expect(ArgoSmartRoutingPricing.floorMonthlyUsd(props)).toBe(5);
      expect(ArgoSmartRoutingPricing.rates(props)[0].label).toContain(
        "unresolved at plan time",
      );
    });

    test("an unresolved prop is distinguished from an absent one", () => {
      // Absent — the default really is what Cloudflare will apply.
      expect(ArgoSmartRoutingPricing.rates({ zoneId: "zone" })[0].label).toBe(
        "Argo Smart Routing data transfer",
      );
    });
  });
});
