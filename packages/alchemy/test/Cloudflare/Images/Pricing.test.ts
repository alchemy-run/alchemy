import { ImagesPricing } from "@/Cloudflare/Images/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("ImagesPricing", () => {
  test("floors to $0 and runs on the free plan", () => {
    expect(ImagesPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(ImagesPricing.requiresPaidPlan).toBe(false);
  });

  test("exposes stored, delivered and transformed", () => {
    const rates = ImagesPricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual([
      "Images stored",
      "Images delivered",
      "Images transformed",
    ]);
    expect(rates[0].perUnit).toBe(5);
    expect(rates[0].unit).toBe("100,000 images stored/month");
    expect(rates[1].perUnit).toBe(1);
    expect(rates[1].unit).toBe("100,000 images delivered/month");
    expect(rates[2].perUnit).toBe(0.5);
    expect(rates[2].unit).toBe("1,000 unique transformations/month");
    expect(rates[2].freeIncluded).toBe("5,000/mo free");
  });

  // No variant prop changes which rate applies, so unresolved plan-time
  // Outputs (including a whole-props Output) must not perturb the rates.
  test("rates are prop-independent, resolved or not", () => {
    const baseline = ImagesPricing.rates(undefined);
    expect(
      ImagesPricing.rates({ fit: "cover", width: 100, height: 100 }),
    ).toEqual(baseline);
    expect(
      ImagesPricing.rates({
        fit: "cover",
        width: asOutput(100),
        height: 100,
      }),
    ).toEqual(baseline);
    expect(
      ImagesPricing.rates(
        asOutput({ fit: "cover" as const, width: 100, height: 100 }),
      ),
    ).toEqual(baseline);
  });
});
