import {
  DispatchNamespacePricing,
  WORKERS_FOR_PLATFORMS_MONTHLY_USD,
} from "@/Cloudflare/WorkersForPlatforms/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("DispatchNamespacePricing", () => {
  test("carries the $25/mo Workers for Platforms plan as a real floor", () => {
    expect(WORKERS_FOR_PLATFORMS_MONTHLY_USD).toBe(25);
    expect(DispatchNamespacePricing.floorMonthlyUsd(undefined)).toBe(25);
    expect(
      DispatchNamespacePricing.floorMonthlyUsd({ name: "customers" }),
    ).toBe(25);
  });

  // The $25/mo plan supersedes the $5/mo Workers Paid subscription, so the
  // fee belongs in floorMonthlyUsd — not the flag the CLI uses to add the
  // Workers Paid fee once.
  test("does not claim the Workers Paid plan fee", () => {
    expect(DispatchNamespacePricing.requiresPaidPlan).toBe(false);
  });

  test("exposes requests, CPU time and per-script rates", () => {
    const rates = DispatchNamespacePricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual([
      "Workers for Platforms requests",
      "Workers for Platforms CPU time",
      "Workers for Platforms user Workers",
    ]);
    expect(rates.map((r) => r.perUnit)).toEqual([0.3, 0.02, 0.02]);
    expect(rates.map((r) => r.unit)).toEqual([
      "million requests",
      "million ms",
      "script",
    ]);
    expect(rates.map((r) => r.freeIncluded)).toEqual([
      "20M/mo included",
      "60M ms/mo included",
      "1,000 scripts included",
    ]);
  });

  // `name` is the namespace's identity, never a rate input — an unresolved
  // Output name must not perturb the floor or the rate lines.
  test("an unresolved name changes neither the floor nor the rates", () => {
    const baseline = DispatchNamespacePricing.rates(undefined);
    expect(
      DispatchNamespacePricing.rates({ name: asOutput("customers") }),
    ).toEqual(baseline);
    expect(
      DispatchNamespacePricing.floorMonthlyUsd({ name: asOutput("customers") }),
    ).toBe(25);
    expect(
      DispatchNamespacePricing.rates(asOutput({ name: "customers" })),
    ).toEqual(baseline);
  });
});
