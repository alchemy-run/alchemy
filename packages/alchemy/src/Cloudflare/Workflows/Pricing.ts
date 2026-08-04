/**
 * Cloudflare Workflows rates, attached to the live Workflow provider's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * A Workflow bills on four dimensions: it shares Workers Standard's
 * request + CPU-time rates (the workflow body runs on the host Worker's
 * compute), and adds its own step and instance-state storage rates.
 *
 * Nothing accrues at zero usage, so `floorMonthlyUsd` is 0; the flat
 * $5/mo Workers Paid subscription is tracked once via `requiresPaidPlan`
 * exactly as `WorkersPricing` does — a Workflow is always hosted by a
 * Worker script.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/workflows/reference/pricing/
 * - https://developers.cloudflare.com/workers/platform/pricing/
 */
import type { ResourceCost } from "../../Cost.ts";
import type { WorkflowResourceProps } from "./Workflow.ts";

/**
 * Steps and state storage start billing 2026-08-10; the rates below are
 * Cloudflare's published numbers for that date onwards.
 */
export const WorkflowsPricing: ResourceCost<WorkflowResourceProps> = {
  // No dimension accrues while no instance runs, and a Workflow with no
  // live instances retains no state.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: true,
  // Nothing on `WorkflowResourceProps` (workflowName / className /
  // scriptName) changes a rate, so there is no `planProp` branch here.
  rates: () => [
    {
      label: "Workflow invocations",
      perUnit: 0.3,
      unit: "million requests",
      freeIncluded: "10M/mo free",
    },
    {
      label: "Workflow CPU time",
      perUnit: 0.02,
      unit: "million ms",
      freeIncluded: "30M ms/mo free",
    },
    {
      label: "Workflow steps",
      perUnit: 0.8,
      unit: "100k steps",
      freeIncluded: "500k/mo free (billed from 2026-08-10)",
    },
    {
      label: "Workflow state storage",
      perUnit: 0.2,
      unit: "GB-month",
      freeIncluded: "1 GB free (billed from 2026-08-10)",
    },
  ],
};
