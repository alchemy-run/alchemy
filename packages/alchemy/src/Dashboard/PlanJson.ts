import type * as Plan from "../Plan.ts";

/**
 * JSON-safe projection of a {@link Plan.Plan} node for the dashboard.
 *
 * Deliberately excludes the desired `props`: plan props are unresolved
 * Input/Output expressions (proxies whose property access materializes new
 * expressions), so serializing them is unsafe. The persisted state (served
 * by /api/graph) remains the source for concrete props/attrs.
 */
export interface DashboardPlanNode {
  fqn: string;
  logicalId: string;
  type: string;
  action: "create" | "update" | "replace" | "delete" | "noop";
  /** replace-only: whether the old resource is deleted before the new one */
  deleteFirst?: boolean;
  downstream: string[];
  bindings: { sid: string; action: string }[];
}

export interface DashboardPlanAction {
  fqn: string;
  logicalId: string;
  /** action (task) type, e.g. "AnnounceDeploy" */
  type: string;
  action: "run" | "noop" | "delete";
  downstream: string[];
}

export interface DashboardPlan {
  available: boolean;
  /** present when available is false */
  error?: string;
  resources: Record<string, DashboardPlanNode>;
  /** orphaned resources that the next apply would delete */
  deletions: Record<string, DashboardPlanNode>;
  actions: Record<string, DashboardPlanAction>;
  /** fqns participating in dependency cycles */
  cycleMembers: string[];
}

export const unavailablePlan = (error: string): DashboardPlan => ({
  available: false,
  error,
  resources: {},
  deletions: {},
  actions: {},
  cycleMembers: [],
});

export const toPlanJson = (plan: Plan.Plan): DashboardPlan => {
  const resources: Record<string, DashboardPlanNode> = {};
  for (const [fqn, node] of Object.entries(plan.resources)) {
    resources[fqn] = {
      fqn,
      logicalId: node.resource.LogicalId,
      type: node.resource.Type,
      action: node.action,
      ...(node.action === "replace"
        ? { deleteFirst: node.deleteFirst }
        : undefined),
      downstream: [...(node.downstream ?? [])],
      bindings: (node.bindings ?? []).map((b) => ({
        sid: b.sid,
        action: b.action,
      })),
    };
  }

  const deletions: Record<string, DashboardPlanNode> = {};
  for (const [fqn, node] of Object.entries(plan.deletions)) {
    if (node === undefined) {
      continue;
    }
    deletions[fqn] = {
      fqn,
      logicalId: node.state.logicalId,
      type: node.state.resourceType,
      action: "delete",
      downstream: [...(node.downstream ?? [])],
      bindings: (node.state.bindings ?? []).map((b) => ({
        sid: b.sid,
        action: "delete",
      })),
    };
  }

  const actions: Record<string, DashboardPlanAction> = {};
  for (const [fqn, node] of Object.entries(plan.actions)) {
    actions[fqn] = {
      fqn,
      logicalId: node.def.LogicalId,
      type: node.def.Type,
      action: node.action,
      downstream: [...(node.downstream ?? [])],
    };
  }
  for (const [fqn, node] of Object.entries(plan.actionDeletions ?? {})) {
    if (node !== undefined) {
      actions[fqn] = {
        fqn,
        logicalId: node.def.LogicalId,
        type: node.def.Type,
        action: "delete",
        downstream: [...(node.downstream ?? [])],
      };
    }
  }

  return {
    available: true,
    resources,
    deletions,
    actions,
    cycleMembers: [...(plan.cycleMembers ?? [])],
  };
};
