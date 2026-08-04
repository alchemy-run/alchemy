import { PagesPricing } from "@/Cloudflare/Pages/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const props = {
  name: "my-site",
  productionBranch: "main",
  buildConfig: { buildCommand: "npm run build", destinationDir: "dist" },
};

describe("PagesPricing", () => {
  describe("floorMonthlyUsd — a project costs nothing until it serves traffic", () => {
    test("floors to $0 with no props", () => {
      expect(PagesPricing.floorMonthlyUsd(undefined)).toBe(0);
    });

    test("floors to $0 for a configured project", () => {
      expect(PagesPricing.floorMonthlyUsd(props)).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("Pages, including Functions, runs on the Workers Free plan", () => {
      expect(PagesPricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates — Functions bill as Workers, static assets are free", () => {
    test("exposes Functions requests, Functions CPU time, and static assets", () => {
      const rates = PagesPricing.rates(props);
      expect(rates.map((r) => r.label)).toEqual([
        "Pages Functions requests",
        "Pages Functions CPU time",
        "Pages static asset requests",
      ]);
    });

    test("Functions requests carry the Workers $0.30/million rate", () => {
      const rates = PagesPricing.rates(props);
      expect(rates[0].perUnit).toBe(0.3);
      expect(rates[0].unit).toBe("million requests");
      expect(rates[0].freeIncluded).toBe(
        "10M/mo free, shared with Workers (100k/day on Free)",
      );
    });

    test("Functions CPU time carries the Workers $0.02/million ms rate", () => {
      const rates = PagesPricing.rates(props);
      expect(rates[1].perUnit).toBe(0.02);
      expect(rates[1].unit).toBe("million ms");
      expect(rates[1].freeIncluded).toBe("30M ms/mo free, shared with Workers");
    });

    test("static asset requests are free and unlimited", () => {
      const rates = PagesPricing.rates(props);
      expect(rates[2].perUnit).toBe(0);
      expect(rates[2].freeIncluded).toBe("always free and unlimited");
    });

    test("the same rates apply with no props at all", () => {
      expect(PagesPricing.rates(undefined)).toEqual(PagesPricing.rates(props));
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. Nothing on a Pages project
  // changes the rate, so an unknown value must simply leave it intact.
  describe("unresolved plan-time Outputs", () => {
    test("an Output name does not disturb the rates", () => {
      const rates = PagesPricing.rates({ name: asOutput("my-site") });
      expect(rates[0].perUnit).toBe(0.3);
      expect(rates[0].label).toBe("Pages Functions requests");
    });

    test("Output-valued deployment bindings do not disturb the rates", () => {
      const rates = PagesPricing.rates({
        deploymentConfigs: {
          production: { kvNamespaces: { CACHE: asOutput("namespace-id") } },
        },
      });
      expect(rates).toEqual(PagesPricing.rates(undefined));
    });

    test("a whole-props Output prices identically", () => {
      const unresolved = asOutput(props);
      expect(PagesPricing.floorMonthlyUsd(unresolved)).toBe(0);
      expect(PagesPricing.rates(unresolved)).toEqual(
        PagesPricing.rates(undefined),
      );
    });
  });
});
