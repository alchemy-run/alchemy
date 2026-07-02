/** Mirrors packages/alchemy/src/Dashboard/Graph.ts */
export interface DashboardNode {
  fqn: string;
  logicalId: string;
  path: string[];
  kind: "resource" | "action";
  type: string;
  status: string;
  props?: Record<string, any>;
  attrs?: Record<string, any>;
  bindings: { sid: string; data: any }[];
  downstream: string[];
}

export interface DashboardEdge {
  source: string;
  target: string;
  kind: "dependency" | "binding";
  sid?: string;
}

export interface DashboardGraph {
  nodes: DashboardNode[];
  edges: DashboardEdge[];
}

export interface DashboardMeta {
  stack: string;
  stage: string;
  stages: string[];
}
