import type { Plan } from "../Plan.ts";
import type { PlanSummary } from "./Surface.ts";

export const summarizePlan = (plan: Plan): PlanSummary => {
  const summary: { -readonly [K in keyof PlanSummary]: PlanSummary[K] } = {
    create: 0,
    update: 0,
    replace: 0,
    delete: 0,
    noop: 0,
  };
  for (const node of Object.values(plan.resources)) summary[node.action]++;
  for (const node of Object.values(plan.deletions)) {
    if (node !== undefined) summary.delete++;
  }
  return summary;
};
