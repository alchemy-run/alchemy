import { AiGatewayPricing } from "@/Cloudflare/AI/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("AiGatewayPricing", () => {
  test("floors to $0 and does not itself require the paid plan", () => {
    expect(AiGatewayPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(AiGatewayPricing.floorMonthlyUsd({ logpush: true })).toBe(0);
    expect(AiGatewayPricing.requiresPaidPlan).toBe(false);
  });

  describe("rates", () => {
    test("a gateway without Logpush shows only the free core line", () => {
      const rates = AiGatewayPricing.rates(undefined);
      expect(rates.map((r) => r.label)).toEqual([
        "AI Gateway requests + persistent logs",
      ]);
      expect(rates[0].perUnit).toBe(0);
      expect(rates[0].freeIncluded).toContain("core features free");
    });

    test("logpush: false reads the same as absent", () => {
      expect(AiGatewayPricing.rates({ logpush: false })).toEqual(
        AiGatewayPricing.rates(undefined),
      );
    });

    test("logpush: true adds the metered Logpush line", () => {
      const rates = AiGatewayPricing.rates({ logpush: true });
      expect(rates.map((r) => r.label)).toEqual([
        "AI Gateway Logpush",
        "AI Gateway requests + persistent logs",
      ]);
      expect(rates[0].perUnit).toBe(0.05);
      expect(rates[0].unit).toBe("million log events");
      expect(rates[0].freeIncluded).toBe("10M/mo free (Workers Paid only)");
    });

    test("other props do not change the rates", () => {
      expect(
        AiGatewayPricing.rates({ id: "gw", cacheTtl: 60, collectLogs: true }),
      ).toEqual(AiGatewayPricing.rates(undefined));
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never silently drop a billable dimension.
  describe("unresolved plan-time Outputs", () => {
    test("an Output logpush prop shows the Logpush line and says so", () => {
      const rates = AiGatewayPricing.rates({ logpush: asOutput(false) });
      expect(rates[0].label).toBe(
        "AI Gateway Logpush (logpush unresolved at plan time — Logpush rates shown)",
      );
      expect(rates[0].perUnit).toBe(0.05);
    });

    test("a whole-props Output shows the unresolved Logpush label", () => {
      const rates = AiGatewayPricing.rates(asOutput({ logpush: false }));
      expect(rates).toHaveLength(2);
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.05);
    });

    test("an unresolved prop is distinguished from an absent one", () => {
      expect(AiGatewayPricing.rates({})).toHaveLength(1);
      expect(AiGatewayPricing.rates({ logpush: asOutput(true) })).toHaveLength(
        2,
      );
    });
  });
});
