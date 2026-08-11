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
  /** client-side annotation from the plan (absent for noop) */
  planAction?: PlanAction;
  /** client-side: latest annotate note from the live apply */
  note?: string;
  /** client-side: captured Effect.log* lines from the live apply */
  logs?: { key: number; level: string; message: string }[];
  /** client-side: what the last apply did to this resource */
  applyResult?: "created" | "updated" | "replaced" | "deleted" | "failed";
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

/** Mirrors packages/alchemy/src/Dashboard/Scene.ts */
export interface SceneFeedEntry {
  key: number;
  id: string;
  text: string;
  status?: string;
  log?: boolean;
}

export interface SceneSession {
  id: string;
  done: boolean;
  failed: boolean;
  feed: SceneFeedEntry[];
}

export interface Scene {
  revision: number;
  stack: string;
  stage: string;
  stages: string[];
  nodes: DashboardNode[];
  edges: DashboardEdge[];
  session: SceneSession | null;
  approval: { id: string } | null;
  planReady: boolean;
  planError?: string;
  stateError?: string;
}

export type PlanAction = "create" | "update" | "replace" | "delete" | "noop";

/** Mirrors packages/alchemy/src/Dashboard/PlanJson.ts */
export interface DashboardPlanNode {
  fqn: string;
  logicalId: string;
  type: string;
  action: PlanAction;
  deleteFirst?: boolean;
  downstream: string[];
  bindings: { sid: string; action: string }[];
}

export interface DashboardPlan {
  available: boolean;
  error?: string;
  resources: Record<string, DashboardPlanNode>;
  deletions: Record<string, DashboardPlanNode>;
  actions: Record<string, { fqn: string; action: "run" | "noop" | "delete" }>;
  cycleMembers: string[];
}
