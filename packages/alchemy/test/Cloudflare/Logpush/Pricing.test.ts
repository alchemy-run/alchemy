import { LogpushPricing } from "@/Cloudflare/Logpush/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const destinationConf = "r2://logs/{DATE}";

describe("LogpushPricing", () => {
  describe("floorMonthlyUsd — a job costs nothing until logs flow", () => {
    test("floors to $0 with no props", () => {
      expect(LogpushPricing.floorMonthlyUsd(undefined)).toBe(0);
    });

    test("floors to $0 for a Workers Logpush job", () => {
      expect(
        LogpushPricing.floorMonthlyUsd({
          dataset: "workers_trace_events",
          destinationConf,
        }),
      ).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("Workers Logpush is gated on the Workers Paid plan", () => {
      expect(LogpushPricing.requiresPaidPlan).toBe(true);
    });
  });

  describe("rates", () => {
    test("exposes the $0.05/million request-log rate for workers_trace_events", () => {
      const rates = LogpushPricing.rates({
        dataset: "workers_trace_events",
        destinationConf,
      });
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Workers Logpush request logs");
      expect(rates[0].perUnit).toBe(0.05);
      expect(rates[0].unit).toBe("million request logs delivered");
      expect(rates[0].freeIncluded).toBe(
        "10M/mo free (after filtering and sampling)",
      );
    });

    test("shows the Workers rate when no props are known at all", () => {
      const rates = LogpushPricing.rates(undefined);
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Workers Logpush request logs");
      expect(rates[0].perUnit).toBe(0.05);
    });

    test("shows no rate for an Enterprise-contract zone dataset", () => {
      expect(
        LogpushPricing.rates({
          zoneId: "zone",
          dataset: "http_requests",
          destinationConf,
        }),
      ).toEqual([]);
    });

    test("shows no rate for other account-scoped contract datasets", () => {
      expect(
        LogpushPricing.rates({ dataset: "audit_logs", destinationConf }),
      ).toEqual([]);
      expect(
        LogpushPricing.rates({ dataset: "firewall_events", destinationConf }),
      ).toEqual([]);
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. An unknown value must degrade to
  // a labeled default, never be silently mis-priced.
  describe("unresolved plan-time Outputs", () => {
    test("an Output dataset shows the Workers rate and says so", () => {
      const rates = LogpushPricing.rates({
        dataset: asOutput("http_requests" as const),
        destinationConf,
      });
      // Falls back to the Workers Logpush line — NOT an empty rate list
      // (the pre-guard behavior: an Output object compared against the
      // dataset set never matched and silently priced the job as free).
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe(
        "Workers Logpush request logs (dataset unresolved at plan time — Workers Logpush rates shown)",
      );
      expect(rates[0].perUnit).toBe(0.05);
    });

    test("an Output destination does not disturb the rate", () => {
      const rates = LogpushPricing.rates({
        dataset: "workers_trace_events",
        destinationConf: asOutput(destinationConf),
      });
      expect(rates[0].label).toBe("Workers Logpush request logs");
      expect(rates[0].perUnit).toBe(0.05);
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = LogpushPricing.rates(
        asOutput({ dataset: "http_requests" as const, destinationConf }),
      );
      expect(rates[0].label).toContain("unresolved at plan time");
      expect(rates[0].perUnit).toBe(0.05);
      expect(
        LogpushPricing.floorMonthlyUsd(
          asOutput({ dataset: "audit_logs" as const, destinationConf }),
        ),
      ).toBe(0);
    });

    test("an unresolved dataset is distinguished from an absent one", () => {
      // Absent — nothing to qualify, so the generic Workers label stands.
      expect(LogpushPricing.rates(undefined)[0].label).toBe(
        "Workers Logpush request logs",
      );
    });
  });
});
