import {
  ContainerPricing,
  KvPricing,
  WorkersPricing,
} from "@/Cloudflare/CloudflarePricing";
import {
  formatCostSummaryLines,
  formatRateUsd,
  WORKERS_PAID_PLAN_USD,
} from "@/Cli/LoggingCli";
import type { CRUD } from "@/Plan";
import { describe, expect, test } from "alchemy-test";

/**
 * `formatCostSummaryLines` only reads `action`/`provider.pricing`/`props`/
 * `resource.Type` off each item — a full `Plan` tree carries far more
 * (bindings, state, diff metadata) that this aggregation logic never
 * touches, so these mocks only fill in what it actually reads.
 */
const mockItem = (
  action: CRUD["action"],
  resourceType: string,
  pricing: unknown,
  props: unknown = undefined,
): CRUD =>
  ({
    action,
    resource: { Type: resourceType, LogicalId: `${resourceType}-logical-id` },
    provider: { pricing },
    props,
  }) as unknown as CRUD;

describe("formatCostSummaryLines", () => {
  test("returns no lines when nothing touched has a pricing model", () => {
    const lines = formatCostSummaryLines([
      mockItem("create", "Cloudflare.Some.UnpricedThing", undefined),
    ]);
    expect(lines).toEqual([]);
  });

  test("adds the Workers Paid base fee exactly once across two paid-plan resources", () => {
    const lines = formatCostSummaryLines([
      mockItem("create", "Cloudflare.Worker", WorkersPricing),
      mockItem("create", "Cloudflare.Container", ContainerPricing, {
        instanceType: "lite",
      }),
    ]);
    const totalLine = lines.find((l) => l.includes("Estimated minimum"));
    expect(totalLine).toContain(`$${WORKERS_PAID_PLAN_USD.toFixed(2)}`);
    // Both floors are $0, so the total should be exactly the base fee once —
    // not doubled for having two paid-plan resources.
    expect(totalLine).toContain("$5.00");
  });

  test("skips the base fee entirely when nothing touched requires the paid plan", () => {
    const lines = formatCostSummaryLines([
      mockItem("create", "Cloudflare.KV.Namespace", KvPricing),
    ]);
    const totalLine = lines.find((l) => l.includes("Estimated minimum"));
    expect(totalLine).toContain("$0.00");
  });

  test("dedupes rate lines by resource type, not by resource instance", () => {
    const lines = formatCostSummaryLines([
      mockItem("create", "Cloudflare.KV.Namespace", KvPricing),
      mockItem("update", "Cloudflare.KV.Namespace", KvPricing),
    ]);
    const kvHeaderCount = lines.filter((l) =>
      l.includes("Cloudflare.KV.Namespace"),
    ).length;
    expect(kvHeaderCount).toBe(1);
  });

  test("ignores deletions and noops — nothing to price on the way out or unchanged", () => {
    const lines = formatCostSummaryLines([
      mockItem("delete", "Cloudflare.Worker", WorkersPricing),
      mockItem("noop", "Cloudflare.Worker", WorkersPricing),
    ]);
    expect(lines).toEqual([]);
  });
});

describe("formatRateUsd", () => {
  test("strips floating-point noise from a computed rate", () => {
    // 0.0000025 * 3600 is 0.009000000000000001 in plain JS arithmetic.
    expect(formatRateUsd(0.0000025 * 3600)).toBe("0.009");
  });

  test("preserves rates across the full published range unchanged", () => {
    expect(formatRateUsd(0.00000007)).toBe("0.00000007");
    expect(formatRateUsd(9.0)).toBe("9");
    expect(formatRateUsd(0.3)).toBe("0.3");
  });
});
