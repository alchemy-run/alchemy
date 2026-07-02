import type {
  DashboardGraph,
  DashboardNode,
  DashboardPlan,
  PlanAction,
} from "./types.ts";

/**
 * Merge the plan into the state graph:
 * - annotate state-backed nodes with their pending plan action
 * - synthesize nodes for resources that exist only in the stack file
 *   (typically `create`) so the canvas shows what a deploy would add
 * - mark orphaned state (plan deletions) as `delete`
 */
export function mergePlan(
  graph: DashboardGraph,
  plan: DashboardPlan | undefined,
): DashboardGraph {
  if (plan === undefined || !plan.available) {
    return graph;
  }

  const actionOf = new Map<string, PlanAction>();
  for (const node of Object.values(plan.resources)) {
    actionOf.set(node.fqn, node.action);
  }
  for (const node of Object.values(plan.deletions)) {
    actionOf.set(node.fqn, "delete");
  }

  const byFqn = new Map(graph.nodes.map((n) => [n.fqn, n]));
  const nodes: DashboardNode[] = graph.nodes.map((n) => {
    const action = actionOf.get(n.fqn);
    // A state-backed resource absent from the plan entirely is also an
    // orphan-in-waiting only if the plan says so; default to no annotation.
    return action === undefined || action === "noop"
      ? n
      : { ...n, planAction: action };
  });

  const edges = [...graph.edges];
  const logicalIds = new Map<string, string[]>();
  const indexLogicalId = (n: { logicalId: string; fqn: string }) => {
    const fqns = logicalIds.get(n.logicalId) ?? [];
    fqns.push(n.fqn);
    logicalIds.set(n.logicalId, fqns);
  };
  for (const n of nodes) {
    indexLogicalId(n);
  }

  // synthesize plan-only nodes (not yet in state)
  const synthesized: DashboardNode[] = [];
  for (const planNode of Object.values(plan.resources)) {
    if (byFqn.has(planNode.fqn)) {
      continue;
    }
    const parts = planNode.fqn.split("/");
    const node: DashboardNode = {
      fqn: planNode.fqn,
      logicalId: planNode.logicalId,
      path: parts.slice(0, -1),
      kind: "resource",
      type: planNode.type,
      status: "pending",
      bindings: [],
      downstream: planNode.downstream,
      planAction: planNode.action,
    };
    synthesized.push(node);
    indexLogicalId(node);
  }
  nodes.push(...synthesized);

  const all = new Set(nodes.map((n) => n.fqn));
  const seen = new Set(edges.map((e) => `${e.kind}:${e.source}->${e.target}`));
  const push = (edge: (typeof edges)[number]) => {
    const key = `${edge.kind}:${edge.source}->${edge.target}`;
    if (!seen.has(key) && edge.source !== edge.target) {
      seen.add(key);
      edges.push(edge);
    }
  };
  // dependency + binding edges contributed by plan-only nodes
  for (const planNode of Object.values(plan.resources)) {
    for (const d of planNode.downstream) {
      if (all.has(planNode.fqn) && all.has(d)) {
        push({ source: planNode.fqn, target: d, kind: "dependency" });
      }
    }
    for (const binding of planNode.bindings) {
      const segments = logicalIds.has(binding.sid)
        ? [binding.sid]
        : binding.sid.split(", ");
      for (const segment of segments) {
        for (const target of logicalIds.get(segment) ?? []) {
          push({
            source: planNode.fqn,
            target,
            kind: "binding",
            sid: binding.sid,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

export const planSummary = (
  plan: DashboardPlan | undefined,
): { action: PlanAction; count: number }[] => {
  if (plan === undefined || !plan.available) {
    return [];
  }
  const counts = new Map<PlanAction, number>();
  for (const node of Object.values(plan.resources)) {
    if (node.action !== "noop") {
      counts.set(node.action, (counts.get(node.action) ?? 0) + 1);
    }
  }
  const deletions = Object.keys(plan.deletions).length;
  if (deletions > 0) {
    counts.set("delete", (counts.get("delete") ?? 0) + deletions);
  }
  return [...counts.entries()].map(([action, count]) => ({ action, count }));
};
