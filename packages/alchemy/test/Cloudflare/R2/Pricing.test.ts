import { DataCatalogPricing } from "@/Cloudflare/R2/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("DataCatalogPricing", () => {
  test("floors to $0 and runs without the Workers Paid plan", () => {
    expect(DataCatalogPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(
      DataCatalogPricing.floorMonthlyUsd({ bucketName: "warehouse" }),
    ).toBe(0);
    expect(DataCatalogPricing.requiresPaidPlan).toBe(false);
  });

  test("always exposes catalog operations", () => {
    const rates = DataCatalogPricing.rates(undefined);
    expect(rates).toHaveLength(1);
    expect(rates[0].label).toBe("R2 Data Catalog operations");
    expect(rates[0].perUnit).toBe(9.0);
    expect(rates[0].unit).toBe("million operations");
    expect(rates[0].freeIncluded).toBe("1M/mo free");
  });

  // Compaction is opt-in — a catalog that never enables it never incurs
  // the compaction dimensions, so they are not shown as reference rates.
  test("omits the compaction rates when compaction is unset or disabled", () => {
    expect(
      DataCatalogPricing.rates({ bucketName: "warehouse" }).map((r) => r.label),
    ).toEqual(["R2 Data Catalog operations"]);
    expect(
      DataCatalogPricing.rates({
        bucketName: "warehouse",
        compaction: { state: "disabled" },
      }).map((r) => r.label),
    ).toEqual(["R2 Data Catalog operations"]);
  });

  test("adds the compaction rates when compaction is enabled", () => {
    const rates = DataCatalogPricing.rates({
      bucketName: "warehouse",
      compaction: { state: "enabled" },
    });
    expect(rates).toHaveLength(3);
    expect(rates[1].label).toBe(
      "R2 Data Catalog compaction data processed (compaction target 128 MB)",
    );
    expect(rates[1].perUnit).toBe(0.005);
    expect(rates[1].unit).toBe("GB processed");
    expect(rates[1].freeIncluded).toBe("10 GB/mo free");
    expect(rates[2].label).toBe(
      "R2 Data Catalog compaction objects processed (compaction target 128 MB)",
    );
    expect(rates[2].perUnit).toBe(2.0);
    expect(rates[2].unit).toBe("million objects");
    expect(rates[2].freeIncluded).toBe("1M/mo free");
  });

  test("notes the configured compaction target size", () => {
    const rates = DataCatalogPricing.rates({
      bucketName: "warehouse",
      compaction: { state: "enabled", targetSizeMb: "512" },
    });
    expect(rates[1].label).toContain("compaction target 512 MB");
    expect(rates[2].label).toContain("compaction target 512 MB");
  });

  // An unresolved compaction setting must never be read as "disabled" —
  // that would silently hide two real billing dimensions.
  describe("unresolved plan-time Outputs", () => {
    test("an Output compaction block shows the enabled rates and says so", () => {
      const rates = DataCatalogPricing.rates({
        bucketName: "warehouse",
        compaction: asOutput({ state: "disabled" as const }),
      });
      expect(rates).toHaveLength(3);
      expect(rates[1].label).toBe(
        "R2 Data Catalog compaction data processed (compaction unresolved at plan time — enabled rates shown)",
      );
      expect(rates[2].label).toBe(
        "R2 Data Catalog compaction objects processed (compaction unresolved at plan time — enabled rates shown)",
      );
      expect(rates[1].perUnit).toBe(0.005);
      expect(rates[2].perUnit).toBe(2.0);
    });

    test("an Output nested inside the compaction block is unresolved too", () => {
      const rates = DataCatalogPricing.rates({
        bucketName: "warehouse",
        compaction: { state: asOutput("disabled" as const) },
      });
      expect(rates).toHaveLength(3);
      expect(rates[1].label).toContain("compaction unresolved at plan time");
    });

    test("a wholly unresolved props bag shows the enabled rates", () => {
      const rates = DataCatalogPricing.rates(
        asOutput({
          bucketName: "warehouse",
          compaction: { state: "disabled" as const },
        }),
      );
      expect(rates).toHaveLength(3);
      expect(rates[1].label).toContain("compaction unresolved at plan time");
    });

    // The bucket name is not a rate input.
    test("an unresolved bucketName leaves the rates untouched", () => {
      expect(
        DataCatalogPricing.rates({ bucketName: asOutput("warehouse") }),
      ).toEqual(DataCatalogPricing.rates(undefined));
    });
  });
});
