import {
  RealtimeSfuPricing,
  RealtimeTurnPricing,
} from "@/Cloudflare/Calls/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("Realtime (Calls) pricing", () => {
  test("both float to $0 and run on the free plan", () => {
    expect(RealtimeSfuPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(RealtimeTurnPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(RealtimeSfuPricing.requiresPaidPlan).toBe(false);
    expect(RealtimeTurnPricing.requiresPaidPlan).toBe(false);
  });

  test("SFU charges egress only — ingress is free", () => {
    const rates = RealtimeSfuPricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual([
      "Realtime SFU egress",
      "Realtime SFU ingress",
    ]);
    expect(rates[0].perUnit).toBe(0.05);
    expect(rates[0].unit).toBe("GB egress");
    expect(rates[1].perUnit).toBe(0);
    expect(rates[1].freeIncluded).toBe("always free");
  });

  test("TURN charges the same egress rate", () => {
    const rates = RealtimeTurnPricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual(["Realtime TURN egress"]);
    expect(rates[0].perUnit).toBe(0.05);
    expect(rates[0].unit).toBe("GB egress");
  });

  test("the 1,000 GB free tier is shared across SFU and TURN", () => {
    const shared = "1,000 GB/mo free (shared across SFU + TURN)";
    expect(RealtimeSfuPricing.rates(undefined)[0].freeIncluded).toBe(shared);
    expect(RealtimeTurnPricing.rates(undefined)[0].freeIncluded).toBe(shared);
  });

  // Neither resource has a price-determining prop, so an unresolved
  // plan-time Output must leave the rates untouched.
  test("rates are prop-independent, resolved or not", () => {
    const sfu = RealtimeSfuPricing.rates(undefined);
    expect(RealtimeSfuPricing.rates({ name: "meet" })).toEqual(sfu);
    expect(RealtimeSfuPricing.rates({ name: asOutput("meet") })).toEqual(sfu);
    expect(RealtimeSfuPricing.rates(asOutput({ name: "meet" }))).toEqual(sfu);

    const turn = RealtimeTurnPricing.rates(undefined);
    expect(RealtimeTurnPricing.rates({ name: asOutput("relay") })).toEqual(
      turn,
    );
    expect(RealtimeTurnPricing.rates(asOutput({ name: "relay" }))).toEqual(
      turn,
    );
  });
});
