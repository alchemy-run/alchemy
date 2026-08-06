import { StreamPricing } from "@/Cloudflare/Stream/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("StreamPricing", () => {
  test("floors to $0 and runs on the free plan", () => {
    expect(StreamPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(StreamPricing.floorMonthlyUsd({})).toBe(0);
    expect(StreamPricing.requiresPaidPlan).toBe(false);
  });

  describe("rates", () => {
    test("an input that records nothing shows delivery + free ingest only", () => {
      const rates = StreamPricing.rates(undefined);
      expect(rates.map((r) => r.label)).toEqual([
        "Stream delivery",
        "Stream ingest + encoding",
      ]);
      expect(rates[0].perUnit).toBe(1);
      expect(rates[0].unit).toBe("1,000 minutes delivered");
      expect(rates[1].perUnit).toBe(0);
      expect(rates[1].freeIncluded).toBe("always free");
    });

    test("recording mode off is the same as absent", () => {
      const rates = StreamPricing.rates({ recording: { mode: "off" } });
      expect(rates.map((r) => r.label)).toEqual([
        "Stream delivery",
        "Stream ingest + encoding",
      ]);
    });

    test("automatic recording adds the storage dimension", () => {
      const rates = StreamPricing.rates({
        recording: { mode: "automatic", timeoutSeconds: 10 },
      });
      expect(rates.map((r) => r.label)).toEqual([
        "Stream storage (recording: automatic)",
        "Stream delivery",
        "Stream ingest + encoding",
      ]);
      expect(rates[0].perUnit).toBe(5);
      expect(rates[0].unit).toBe(
        "1,000 minutes stored/month (prepaid in $5 increments)",
      );
    });

    test("a recording object without a mode reads as off", () => {
      const rates = StreamPricing.rates({ recording: { timeoutSeconds: 10 } });
      expect(rates[0].label).toBe("Stream delivery");
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never silently drop a billable dimension.
  describe("unresolved plan-time Outputs", () => {
    test("an Output recording prop shows storage and says so", () => {
      const rates = StreamPricing.rates({
        recording: asOutput({ mode: "off" as const }),
      });
      expect(rates[0].label).toBe(
        "Stream storage (recording mode unresolved at plan time — recorded rates shown)",
      );
      expect(rates[0].perUnit).toBe(5);
    });

    test("an Output nested inside recording is unresolved too", () => {
      const rates = StreamPricing.rates({
        recording: { mode: asOutput("off" as const) },
      });
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(5);
    });

    test("a whole-props Output shows the unresolved storage label", () => {
      const rates = StreamPricing.rates(
        asOutput({ recording: { mode: "off" as const } }),
      );
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates).toHaveLength(3);
    });
  });
});
