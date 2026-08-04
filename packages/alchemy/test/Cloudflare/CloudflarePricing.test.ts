import {
  containerActiveHourlyUsd,
  ContainerPricing,
  D1Pricing,
  KvPricing,
  QueuesPricing,
  R2Pricing,
  VectorizePricing,
  WorkersPricing,
} from "@/Cloudflare/CloudflarePricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("CloudflarePricing", () => {
  describe("floors — nothing here has a nonzero cost at zero usage", () => {
    test("Workers, KV, R2, D1, Queues, Vectorize, Containers all floor to $0", () => {
      expect(WorkersPricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(KvPricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(R2Pricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(D1Pricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(QueuesPricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(VectorizePricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(ContainerPricing.floorMonthlyUsd(undefined)).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("Workers and Containers require the Workers Paid plan", () => {
      expect(WorkersPricing.requiresPaidPlan).toBe(true);
      expect(ContainerPricing.requiresPaidPlan).toBe(true);
    });

    test("KV, R2, D1, Queues, Vectorize run on the free plan", () => {
      expect(KvPricing.requiresPaidPlan).toBe(false);
      expect(R2Pricing.requiresPaidPlan).toBe(false);
      expect(D1Pricing.requiresPaidPlan).toBe(false);
      expect(QueuesPricing.requiresPaidPlan).toBe(false);
      expect(VectorizePricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates", () => {
    test("Workers exposes requests + CPU time", () => {
      const rates = WorkersPricing.rates(undefined);
      expect(rates.map((r) => r.label)).toEqual([
        "Workers requests",
        "Workers CPU time",
      ]);
      expect(rates[0].perUnit).toBe(0.3);
      expect(rates[1].perUnit).toBe(0.02);
    });

    test("R2 picks Standard rates by default", () => {
      const rates = R2Pricing.rates(undefined);
      expect(rates[0].label).toBe("R2 storage (Standard)");
      expect(rates[0].perUnit).toBe(0.015);
    });

    test("R2 picks Infrequent Access rates when storageClass is set", () => {
      const rates = R2Pricing.rates({ storageClass: "InfrequentAccess" });
      expect(rates[0].label).toBe("R2 storage (InfrequentAccess)");
      expect(rates[0].perUnit).toBe(0.01);
      expect(rates[1].perUnit).toBe(9.0);
      expect(rates[2].perUnit).toBe(0.9);
    });

    test("R2 egress is free on both storage classes", () => {
      expect(R2Pricing.rates(undefined).at(-1)?.perUnit).toBe(0);
      expect(
        R2Pricing.rates({ storageClass: "InfrequentAccess" }).at(-1)?.perUnit,
      ).toBe(0);
    });

    test("Vectorize notes the configured dimensions in its stored-dimension label", () => {
      const withDims = VectorizePricing.rates({ dimensions: 768 });
      expect(withDims[1].label).toContain("768");
      const withoutDims = VectorizePricing.rates(undefined);
      expect(withoutDims[1].label).not.toContain("undefined");
    });
  });

  describe("containerActiveHourlyUsd", () => {
    test("matches a hand-computed value for lite (0.25 GiB / 2 GB)", () => {
      // (0.25 * 0.0000025 + 2 * 0.00000007) * 3600
      const expected = (0.25 * 0.0000025 + 2 * 0.00000007) * 3600;
      expect(containerActiveHourlyUsd("lite")).toBeCloseTo(expected, 10);
    });

    test("dev is an alias for lite", () => {
      expect(containerActiveHourlyUsd("dev")).toBe(
        containerActiveHourlyUsd("lite"),
      );
    });

    test("undefined defaults to lite", () => {
      expect(containerActiveHourlyUsd(undefined)).toBe(
        containerActiveHourlyUsd("lite"),
      );
    });

    test("standard-1 costs more than lite", () => {
      expect(containerActiveHourlyUsd("standard-1")).toBeGreaterThan(
        containerActiveHourlyUsd("lite"),
      );
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never be silently mis-priced.
  describe("unresolved plan-time Outputs", () => {
    test("Container with an Output instanceType shows lite rates and says so", () => {
      const rates = ContainerPricing.rates({
        instanceType: asOutput("standard-3" as const),
      });
      expect(rates[0].label).toBe(
        "Container active time (instance type unresolved at plan time — lite rates shown)",
      );
      // Falls back to the lite baseline — NOT $0 (the pre-guard behavior:
      // an Output object indexed into the rate table missed every tier).
      expect(rates[0].perUnit).toBe(containerActiveHourlyUsd("lite"));
      expect(rates[0].perUnit).toBeGreaterThan(0);
    });

    test("R2 with an Output storageClass shows Standard rates and says so", () => {
      const rates = R2Pricing.rates({
        storageClass: asOutput("InfrequentAccess" as const),
      });
      expect(rates[0].label).toBe(
        "R2 storage (storage class unresolved at plan time — Standard rates shown)",
      );
      expect(rates[0].perUnit).toBe(0.015);
    });

    test("Vectorize with Output dimensions falls back to the generic label", () => {
      const rates = VectorizePricing.rates({
        name: "index",
        dimensions: asOutput(768),
        metric: "cosine",
      });
      expect(rates[1].label).toBe("Vectorize stored dimensions");
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = ContainerPricing.rates(
        asOutput({ instanceType: "standard-3" as const }),
      );
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(containerActiveHourlyUsd("lite"));
    });

    test("an unresolved prop is distinguished from an absent one", () => {
      // Absent — the default really is what Cloudflare will provision.
      expect(ContainerPricing.rates(undefined)[0].label).toBe(
        "Container active time (lite)",
      );
      expect(ContainerPricing.rates({})[0].label).toBe(
        "Container active time (lite)",
      );
    });
  });
});
