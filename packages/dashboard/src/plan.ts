import type { DashboardNode, PlanAction } from "./types.ts";

/**
 * Summarize the pending plan actions carried on the scene's nodes
 * (assembled server-side — see packages/alchemy/src/Dashboard/Scene.ts).
 */
export const planSummary = (
  nodes: DashboardNode[],
): { action: PlanAction; count: number }[] => {
  const counts = new Map<PlanAction, number>();
  for (const node of nodes) {
    if (node.planAction) {
      counts.set(node.planAction, (counts.get(node.planAction) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([action, count]) => ({ action, count }));
};
