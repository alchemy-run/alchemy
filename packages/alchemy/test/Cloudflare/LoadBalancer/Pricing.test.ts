import {
  LOAD_BALANCING_MONTHLY_USD,
  LoadBalancerPricing,
} from "@/Cloudflare/LoadBalancer/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const props = {
  zoneId: "zone",
  name: "lb.example.com",
  defaultPools: ["pool"],
  fallbackPool: "pool",
};

describe("LoadBalancerPricing", () => {
  test("charges the published $5/mo Load Balancing add-on fee at zero usage", () => {
    expect(LOAD_BALANCING_MONTHLY_USD).toBe(5);
    expect(LoadBalancerPricing.floorMonthlyUsd(props)).toBe(5);
  });

  test("the fee is independent of every prop", () => {
    expect(LoadBalancerPricing.floorMonthlyUsd(undefined)).toBe(5);
    expect(
      LoadBalancerPricing.floorMonthlyUsd({
        ...props,
        proxied: true,
        steeringPolicy: "geo",
        defaultPools: ["a", "b", "c"],
      }),
    ).toBe(5);
  });

  test("the add-on fee is not the Workers Paid plan fee", () => {
    // requiresPaidPlan is deduped plan-wide for the $5/mo Workers Paid
    // plan; Load Balancing is a separate, additive product fee, which is
    // why it lives in floorMonthlyUsd instead.
    expect(LoadBalancerPricing.requiresPaidPlan).toBe(false);
  });

  test("publishes no per-unit rates — Cloudflare quotes them only in the dashboard", () => {
    expect(LoadBalancerPricing.rates(props)).toEqual([]);
    expect(LoadBalancerPricing.rates(undefined)).toEqual([]);
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. Nothing here is prop-derived, so
  // the fee must survive both an unresolved prop and unresolved props.
  describe("unresolved plan-time Outputs", () => {
    test("an Output prop still bills the flat fee", () => {
      expect(
        LoadBalancerPricing.floorMonthlyUsd({
          ...props,
          zoneId: asOutput("zone"),
        }),
      ).toBe(5);
    });

    test("a whole-props Output still bills the flat fee", () => {
      expect(LoadBalancerPricing.floorMonthlyUsd(asOutput(props))).toBe(5);
      expect(LoadBalancerPricing.rates(asOutput(props))).toEqual([]);
    });
  });
});
