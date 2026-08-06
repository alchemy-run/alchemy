import { RealtimeKitPricing } from "@/Cloudflare/RealtimeKit/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("RealtimeKitPricing", () => {
  test("floors to $0 and runs on the free plan", () => {
    expect(RealtimeKitPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(RealtimeKitPricing.requiresPaidPlan).toBe(false);
  });

  test("exposes participant-minute and export rates", () => {
    const rates = RealtimeKitPricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual([
      "RealtimeKit audio/video participant",
      "RealtimeKit audio-only participant",
      "RealtimeKit export (recording, RTMP or HLS)",
      "RealtimeKit export (audio-only recording/streaming)",
      "RealtimeKit export (raw RTP into R2)",
    ]);
    expect(rates.map((r) => r.perUnit)).toEqual([
      0.002, 0.0005, 0.01, 0.003, 0.0005,
    ]);
  });

  test("participant lines are billed per participant-minute", () => {
    const rates = RealtimeKitPricing.rates(undefined);
    expect(rates[0].unit).toBe("participant-minute");
    expect(rates[1].unit).toBe("participant-minute");
    expect(rates.slice(2).map((r) => r.unit)).toEqual([
      "minute",
      "minute",
      "minute",
    ]);
  });

  test("every line is flagged free during Beta", () => {
    for (const rate of RealtimeKitPricing.rates(undefined)) {
      expect(rate.freeIncluded).toBe("free during Beta");
    }
  });

  // The app has no price-determining prop (participant classification is
  // decided by the preset at join time), so unresolved plan-time Outputs
  // must leave the rates untouched.
  test("rates are prop-independent, resolved or not", () => {
    const baseline = RealtimeKitPricing.rates(undefined);
    expect(RealtimeKitPricing.rates({ name: "town-hall" })).toEqual(baseline);
    expect(RealtimeKitPricing.rates({ name: asOutput("town-hall") })).toEqual(
      baseline,
    );
    expect(RealtimeKitPricing.rates(asOutput({ name: "town-hall" }))).toEqual(
      baseline,
    );
  });
});
