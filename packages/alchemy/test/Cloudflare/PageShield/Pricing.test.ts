import { PageShieldPricing } from "@/Cloudflare/PageShield/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const zoneId = "0123456789abcdef0123456789abcdef";

describe("PageShieldPricing", () => {
  describe("floor", () => {
    test("purely usage-metered — $0 at zero traffic", () => {
      expect(PageShieldPricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(PageShieldPricing.floorMonthlyUsd({ zoneId })).toBe(0);
      expect(
        PageShieldPricing.floorMonthlyUsd({ zoneId, enabled: false }),
      ).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("a zone add-on, unrelated to the Workers Paid plan", () => {
      expect(PageShieldPricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates", () => {
    test("exposes the published $0.099/1k requests meter", () => {
      const rates = PageShieldPricing.rates({ zoneId });
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Client-Side Security requests");
      expect(rates[0].perUnit).toBe(0.099);
      expect(rates[0].unit).toBe("1k requests");
      expect(rates[0].freeIncluded).toBe(
        "basic script monitoring included on all plan tiers",
      );
    });

    test("absent props price the same as an absent `enabled` — the resource enables by default", () => {
      expect(PageShieldPricing.rates(undefined)).toEqual(
        PageShieldPricing.rates({ zoneId }),
      );
      expect(PageShieldPricing.rates({ zoneId, enabled: true })).toEqual(
        PageShieldPricing.rates({ zoneId }),
      );
    });

    test("explicitly disabled scans nothing, so meters nothing", () => {
      expect(PageShieldPricing.rates({ zoneId, enabled: false })).toEqual([]);
    });

    test("the other settings props don't move the rate", () => {
      const rates = PageShieldPricing.rates({
        zoneId,
        useConnectionUrlPath: true,
        useCloudflareReportingEndpoint: false,
      });
      expect(rates[0].perUnit).toBe(0.099);
      expect(rates[0].label).toBe("Client-Side Security requests");
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never be silently mis-priced.
  describe("unresolved plan-time Outputs", () => {
    test("an Output `enabled` shows the metered rate and says so", () => {
      const rates = PageShieldPricing.rates({
        zoneId,
        enabled: asOutput(false),
      });
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe(
        "Client-Side Security requests (enabled unresolved at plan time — metered rates shown)",
      );
      // Falls back to metered — NOT silently dropped to no rate at all
      // (an Output object compared against `false` is never equal).
      expect(rates[0].perUnit).toBe(0.099);
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = PageShieldPricing.rates(
        asOutput({ zoneId, enabled: false }),
      );
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.099);
    });

    test("an unresolved prop is distinguished from an absent one", () => {
      // Absent — the documented default (enabled) really is what deploys.
      expect(PageShieldPricing.rates({ zoneId })[0].label).toBe(
        "Client-Side Security requests",
      );
      expect(
        PageShieldPricing.rates({ zoneId, enabled: asOutput(true) })[0].label,
      ).toContain("unresolved at plan time");
    });
  });
});
