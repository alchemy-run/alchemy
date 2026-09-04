import { parseFqn } from "../FQN.ts";
import type { ActionState } from "../State/ActionState.ts";
import type { ResourceState } from "../State/ResourceState.ts";
import { encodeState } from "../State/StateEncoding.ts";

/**
 * JSON-friendly view of one node in the dashboard graph. Everything the SPA
 * needs to render a canvas node + inspector without further API calls.
 * `props`/`attrs` are passed through `encodeState`, so secrets are redacted.
 */
export interface DashboardNode {
  fqn: string;
  logicalId: string;
  /** namespace path segments (fqn minus the logical id) */
  path: string[];
  kind: "resource" | "action";
  /** resource type (e.g. "AWS.S3.Bucket") or action type */
  type: string;
  status: string;
  props?: Record<string, any>;
  attrs?: Record<string, any>;
  bindings: { sid: string; data: any }[];
  downstream: string[];
}

export interface DashboardEdge {
  /** fqn of the source node */
  source: string;
  /** fqn of the target node */
  target: string;
  /**
   * - dependency: `target` consumes an output of `source`
   * - binding: `source` (a Function/Worker host) is bound to `target`
   */
  kind: "dependency" | "binding";
  /** binding sid, for binding edges */
  sid?: string;
}

export interface DashboardGraph {
  nodes: DashboardNode[];
  edges: DashboardEdge[];
}

export const toNode = (state: ResourceState | ActionState): DashboardNode => {
  const encoded = encodeState(state) as any;
  const { path } = parseFqn(state.fqn);
  if (state.kind === "action") {
    return {
      fqn: state.fqn,
      logicalId: state.logicalId,
      path,
      kind: "action",
      type: state.actionType,
      status: state.status,
      props: encoded.input as Record<string, any> | undefined,
      attrs: encoded.output as Record<string, any> | undefined,
      bindings: [],
      downstream: [...(state.downstream ?? [])],
    };
  }
  return {
    fqn: state.fqn,
    logicalId: state.logicalId,
    path,
    kind: "resource",
    type: state.resourceType,
    status: state.status,
    props: encoded.props,
    attrs: encoded.attr,
    bindings: ((encoded.bindings ?? []) as { sid: string; data: any }[]).map(
      (b) => ({ sid: b.sid, data: b.data }),
    ),
    downstream: [...(state.downstream ?? [])],
  };
};

/**
 * Derive the edge list from persisted node state.
 *
 * - Dependency edges come from `downstream`: each entry is an fqn that
 *   depends on the node, so the edge runs node → downstream.
 * - Binding edges come from `bindings`: each binding's `sid` was rendered
 *   from the bound resources' LogicalIds (see `Resource.bind`), so sids are
 *   matched back to nodes by logical id — whole-sid first, then per
 *   comma-separated segment for multi-resource sids.
 */
export const toGraph = (
  states: (ResourceState | ActionState)[],
): DashboardGraph => {
  const nodes = states.map(toNode);
  const byFqn = new Set(nodes.map((n) => n.fqn));
  const byLogicalId = new Map<string, string[]>();
  for (const n of nodes) {
    const fqns = byLogicalId.get(n.logicalId) ?? [];
    fqns.push(n.fqn);
    byLogicalId.set(n.logicalId, fqns);
  }

  const edges: DashboardEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: DashboardEdge) => {
    const key = `${edge.kind}:${edge.source}->${edge.target}`;
    if (!seen.has(key) && edge.source !== edge.target) {
      seen.add(key);
      edges.push(edge);
    }
  };

  for (const node of nodes) {
    for (const d of node.downstream) {
      if (byFqn.has(d)) {
        push({ source: node.fqn, target: d, kind: "dependency" });
      }
    }
    for (const binding of node.bindings) {
      const segments = byLogicalId.has(binding.sid)
        ? [binding.sid]
        : binding.sid.split(", ");
      for (const segment of segments) {
        for (const target of byLogicalId.get(segment) ?? []) {
          push({ source: node.fqn, target, kind: "binding", sid: binding.sid });
        }
      }
    }
  }

  return { nodes, edges };
};
