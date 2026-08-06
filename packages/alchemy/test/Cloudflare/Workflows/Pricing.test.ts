import { WorkflowsPricing } from "@/Cloudflare/Workflows/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("WorkflowsPricing", () => {
  test("floors to $0 — every dimension is metered", () => {
    expect(WorkflowsPricing.floorMonthlyUsd(undefined)).toBe(0);
    expect(
      WorkflowsPricing.floorMonthlyUsd({
        workflowName: "wf",
        className: "MyWorkflow",
        scriptName: "worker",
      }),
    ).toBe(0);
  });

  test("requires the Workers Paid plan — a Workflow is hosted by a Worker", () => {
    expect(WorkflowsPricing.requiresPaidPlan).toBe(true);
  });

  test("exposes invocations, CPU time, steps and state storage", () => {
    const rates = WorkflowsPricing.rates(undefined);
    expect(rates.map((r) => r.label)).toEqual([
      "Workflow invocations",
      "Workflow CPU time",
      "Workflow steps",
      "Workflow state storage",
    ]);
    expect(rates.map((r) => r.perUnit)).toEqual([0.3, 0.02, 0.8, 0.2]);
    expect(rates.map((r) => r.unit)).toEqual([
      "million requests",
      "million ms",
      "100k steps",
      "GB-month",
    ]);
  });

  test("publishes the free allotment on every dimension", () => {
    const rates = WorkflowsPricing.rates(undefined);
    expect(rates[0].freeIncluded).toBe("10M/mo free");
    expect(rates[1].freeIncluded).toBe("30M ms/mo free");
    expect(rates[2].freeIncluded).toContain("500k/mo free");
    expect(rates[3].freeIncluded).toContain("1 GB free");
  });

  // No prop changes a Workflow rate, so resolved and unresolved props must
  // produce byte-identical rate lines — an unresolved Output can never
  // silently drop a dimension.
  test("rates are prop-independent, resolved or not", () => {
    const baseline = WorkflowsPricing.rates(undefined);
    expect(
      WorkflowsPricing.rates({
        workflowName: "wf",
        className: "MyWorkflow",
        scriptName: "worker",
      }),
    ).toEqual(baseline);
    expect(
      WorkflowsPricing.rates({
        workflowName: asOutput("wf"),
        className: "MyWorkflow",
        scriptName: asOutput("worker"),
      }),
    ).toEqual(baseline);
    expect(
      WorkflowsPricing.rates(
        asOutput({
          workflowName: "wf",
          className: "MyWorkflow",
          scriptName: "worker",
        }),
      ),
    ).toEqual(baseline);
  });
});
