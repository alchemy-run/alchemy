import { PipelinePricing, SinkPricing } from "@/Cloudflare/Pipelines/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";
import * as Redacted from "effect/Redacted";

const credentials = {
  accessKeyId: Redacted.make("access-key-id"),
  secretAccessKey: Redacted.make("secret-access-key"),
};

const r2Config = { bucket: "events", credentials };

const catalogConfig = {
  bucket: "events",
  tableName: "events",
  token: Redacted.make("catalog-token"),
};

describe("PipelinePricing", () => {
  describe("floorMonthlyUsd — nothing is owed until events flow", () => {
    test("floors to $0 with no props", () => {
      expect(PipelinePricing.floorMonthlyUsd(undefined)).toBe(0);
    });

    test("floors to $0 for a configured pipeline", () => {
      expect(
        PipelinePricing.floorMonthlyUsd({
          sql: "INSERT INTO sink SELECT * FROM stream",
        }),
      ).toBe(0);
    });
  });

  test("requires the Workers Paid plan", () => {
    expect(PipelinePricing.requiresPaidPlan).toBe(true);
  });

  describe("rates", () => {
    test("exposes the $0.04/GB SQL transform rate", () => {
      const rates = PipelinePricing.rates(undefined);
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Pipelines SQL transforms");
      expect(rates[0].perUnit).toBe(0.04);
      expect(rates[0].unit).toBe("GB processed");
      expect(rates[0].freeIncluded).toBe("50 GB/mo free");
    });

    test("the SQL text does not change the rate, resolved or not", () => {
      expect(
        PipelinePricing.rates({ sql: "INSERT INTO sink SELECT * FROM stream" }),
      ).toEqual(PipelinePricing.rates(undefined));
      expect(PipelinePricing.rates({ sql: asOutput("INSERT ...") })).toEqual(
        PipelinePricing.rates(undefined),
      );
      expect(PipelinePricing.rates(asOutput({ sql: "INSERT ..." }))).toEqual(
        PipelinePricing.rates(undefined),
      );
    });
  });
});

describe("SinkPricing", () => {
  describe("floorMonthlyUsd — a sink costs nothing until data is delivered", () => {
    test("floors to $0 with no props", () => {
      expect(SinkPricing.floorMonthlyUsd(undefined)).toBe(0);
    });

    test("floors to $0 for a configured sink", () => {
      expect(
        SinkPricing.floorMonthlyUsd({ type: "r2", config: r2Config }),
      ).toBe(0);
    });
  });

  test("requires the Workers Paid plan", () => {
    expect(SinkPricing.requiresPaidPlan).toBe(true);
  });

  describe("rates — the output format picks the delivery rate", () => {
    test("an r2 sink defaults to the $0.03/GB JSON rate", () => {
      const rates = SinkPricing.rates({ type: "r2", config: r2Config });
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Pipelines sink delivery (JSON)");
      expect(rates[0].perUnit).toBe(0.03);
      expect(rates[0].unit).toBe("GB delivered (uncompressed)");
      expect(rates[0].freeIncluded).toBe("50 GB/mo free");
    });

    test("an explicit json format is the same JSON rate", () => {
      const rates = SinkPricing.rates({
        type: "r2",
        config: r2Config,
        format: { type: "json" },
      });
      expect(rates[0].label).toBe("Pipelines sink delivery (JSON)");
      expect(rates[0].perUnit).toBe(0.03);
    });

    test("a parquet format costs $0.06/GB", () => {
      const rates = SinkPricing.rates({
        type: "r2",
        config: r2Config,
        format: { type: "parquet", compression: "zstd" },
      });
      expect(rates[0].label).toBe("Pipelines sink delivery (Parquet)");
      expect(rates[0].perUnit).toBe(0.06);
    });

    test("an Iceberg sink costs $0.06/GB whatever the format says", () => {
      const rates = SinkPricing.rates({
        type: "r2_data_catalog",
        config: catalogConfig,
      });
      expect(rates[0].label).toBe("Pipelines sink delivery (Iceberg)");
      expect(rates[0].perUnit).toBe(0.06);

      const withJsonFormat = SinkPricing.rates({
        type: "r2_data_catalog",
        config: catalogConfig,
        format: { type: "json" },
      });
      expect(withJsonFormat[0].label).toBe("Pipelines sink delivery (Iceberg)");
      expect(withJsonFormat[0].perUnit).toBe(0.06);
    });

    test("shows the JSON default when no props are known at all", () => {
      expect(SinkPricing.rates(undefined)[0].label).toBe(
        "Pipelines sink delivery (JSON)",
      );
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never be silently mis-priced.
  describe("unresolved plan-time Outputs", () => {
    test("an Output format shows JSON rates and says so", () => {
      const rates = SinkPricing.rates({
        type: "r2",
        config: r2Config,
        format: asOutput({ type: "parquet" as const }),
      });
      expect(rates[0].label).toBe(
        "Pipelines sink delivery (output format unresolved at plan time — JSON rates shown)",
      );
      // Falls back to the JSON rate — NOT $0/undefined (the pre-guard
      // behavior: an Output object read as `format.type` matched nothing).
      expect(rates[0].perUnit).toBe(0.03);
    });

    test("an Output nested inside format also degrades", () => {
      const rates = SinkPricing.rates({
        type: "r2",
        config: r2Config,
        format: { type: asOutput("parquet" as const) },
      });
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.03);
    });

    test("an Output sink type shows JSON rates and says so", () => {
      const rates = SinkPricing.rates({
        type: asOutput("r2_data_catalog" as const),
        config: catalogConfig,
      });
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.03);
    });

    test("a known parquet format still wins when only the type is unresolved", () => {
      const rates = SinkPricing.rates({
        type: asOutput("r2" as const),
        config: r2Config,
        format: { type: "parquet" },
      });
      expect(rates[0].label).toBe("Pipelines sink delivery (Parquet)");
      expect(rates[0].perUnit).toBe(0.06);
    });

    test("an Output bucket name does not disturb the rate", () => {
      const rates = SinkPricing.rates({
        type: "r2",
        config: { ...r2Config, bucket: asOutput("events") },
        format: { type: "parquet" },
      });
      expect(rates[0].label).toBe("Pipelines sink delivery (Parquet)");
      expect(rates[0].perUnit).toBe(0.06);
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = SinkPricing.rates(
        asOutput({ type: "r2_data_catalog" as const, config: catalogConfig }),
      );
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.03);
      expect(
        SinkPricing.floorMonthlyUsd(
          asOutput({ type: "r2" as const, config: r2Config }),
        ),
      ).toBe(0);
    });

    test("an unresolved format is distinguished from an absent one", () => {
      // Absent — `json` really is what the sink will write.
      expect(SinkPricing.rates({ type: "r2", config: r2Config })[0].label).toBe(
        "Pipelines sink delivery (JSON)",
      );
    });
  });
});
