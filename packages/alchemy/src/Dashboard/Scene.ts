import type { ApplyEvent } from "../Cli/Event.ts";
import type { ActionState } from "../State/ActionState.ts";
import type { ResourceState } from "../State/ResourceState.ts";
import { toGraph, type DashboardEdge, type DashboardNode } from "./Graph.ts";
import type { DashboardPlan } from "./PlanJson.ts";

/**
 * The scene is the single canonical document the dashboard renders: nodes,
 * edges, and per-node lifecycle (status, pending plan action, last apply
 * result, notes, logs). It is assembled SERVER-side from the state store,
 * the plan, and the live apply session — in one place, with one identity
 * join — so the SPA is a dumb renderer with no client-side merging.
 *
 * Identity: state/plan nodes are keyed by `fqn`; apply events carry the
 * resource's `logicalId` (that is what `session.emit` sends — same as the
 * TUI). The join happens here, once, via a logicalId index over the
 * assembled node set.
 */

export type ApplyResult =
  | "created"
  | "updated"
  | "replaced"
  | "deleted"
  | "ran"
  | "retained"
  | "skipped"
  | "failed";

export interface SceneNode extends DashboardNode {
  /** what the pending/current plan would do (absent for noop) */
  planAction?: "create" | "update" | "replace" | "delete";
  /** what the last apply did to this resource */
  applyResult?: ApplyResult;
  /** latest annotate note from the live apply */
  note?: string;
  /** captured Effect.log* lines from the live apply */
  logs?: { key: number; level: string; message: string }[];
}

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
  nodes: SceneNode[];
  edges: DashboardEdge[];
  /** the live/last apply session overlayed onto the nodes */
  session: SceneSession | null;
  /** a plan awaiting browser approval */
  approval: { id: string } | null;
  /** false while the stage's plan hasn't been computed yet */
  planReady: boolean;
  planError?: string;
  /** the state store failed or timed out — nodes may be incomplete */
  stateError?: string;
}

export interface SessionInput {
  sessionId: string;
  plan: DashboardPlan;
  events: { seq: number; event: ApplyEvent }[];
  done: boolean;
}

/**
 * One entry in a resource's deployment timeline: a status transition, an
 * annotate note, or a captured Effect.log* line. Maintained by the server
 * across sessions (each resource's timeline resets when its NEXT lifecycle
 * operation begins), so logs survive completed deploys.
 */
export interface TimelineEntry {
  key: number;
  /** "status" | "note" | or the log level ("Info", "Error", ...) */
  level: string;
  message: string;
}

/**
 * The stack's SHAPE, from evaluating the stack file without planning — no
 * cloud calls, no credentials, seconds instead of the plan's stack-diff.
 * Lets the canvas render "what this stack defines" immediately, even for
 * an empty stage, upgraded with plan actions when the plan lands.
 */
export interface StackStructure {
  resources: {
    fqn: string;
    logicalId: string;
    type: string;
    bindingSids: string[];
    /** actions (tasks) render as ghost nodes too @default "resource" */
    kind?: "resource" | "action";
  }[];
}

export interface SceneInput {
  revision: number;
  stack: string;
  stage: string;
  stages: string[];
  states: (ResourceState | ActionState)[];
  /**
   * The plan to overlay, by precedence (the server picks): a pending
   * approval's plan > the active session's plan > the computed stage plan.
   */
  plan: DashboardPlan | undefined;
  planReady: boolean;
  planError?: string;
  session: SessionInput | undefined;
  approvalId: string | undefined;
  /** per-resource deployment timelines, keyed by logicalId */
  timelines: ReadonlyMap<string, TimelineEntry[]>;
  /** the stack's shape (see {@link StackStructure}) */
  structure: StackStructure | undefined;
  stateError?: string;
}

const LOG_CAP = 500;

const TERMINAL: Record<string, ApplyResult> = {
  created: "created",
  updated: "updated",
  replaced: "replaced",
  deleted: "deleted",
  ran: "ran",
  retained: "retained",
  skipped: "skipped",
  fail: "failed",
};

export const assembleScene = (input: SceneInput): Scene => {
  // 1. base graph from persisted state
  const { nodes: baseNodes, edges } = toGraph(input.states);
  const nodes: SceneNode[] = baseNodes.map((n) => ({ ...n }));
  const byFqn = new Map(nodes.map((n) => [n.fqn, n]));

  // 2. plan overlay: annotate actions; synthesize nodes that exist only in
  //    the plan — pending creates AND deletions (a destroy plan has empty
  //    `resources` with everything in `deletions`; after the destroy the
  //    state graph is empty too, so without synthesis the architecture
  //    would vanish instead of showing its teardown)
  const plan = input.plan;
  if (plan?.available) {
    const planNodes = [
      ...Object.values(plan.resources),
      ...Object.values(plan.deletions),
    ];
    for (const planNode of planNodes) {
      let node = byFqn.get(planNode.fqn);
      if (node === undefined) {
        node = {
          fqn: planNode.fqn,
          logicalId: planNode.logicalId,
          path: planNode.fqn.split("/").slice(0, -1),
          kind: "resource",
          type: planNode.type,
          // deletions exist(ed) in the cloud; creates don't yet
          status: planNode.action === "delete" ? "created" : "pending",
          bindings: [],
          downstream: planNode.downstream,
        };
        nodes.push(node);
        byFqn.set(node.fqn, node);
      }
      if (planNode.action !== "noop") {
        node.planAction = planNode.action;
      }
    }
    // edges contributed by plan-only nodes
    const logicalIds = new Map<string, string[]>();
    for (const n of nodes) {
      logicalIds.set(n.logicalId, [
        ...(logicalIds.get(n.logicalId) ?? []),
        n.fqn,
      ]);
    }
    const seen = new Set(
      edges.map((e) => `${e.kind}:${e.source}->${e.target}`),
    );
    const push = (edge: DashboardEdge) => {
      const key = `${edge.kind}:${edge.source}->${edge.target}`;
      if (!seen.has(key) && edge.source !== edge.target) {
        seen.add(key);
        edges.push(edge);
      }
    };
    for (const planNode of planNodes) {
      for (const d of planNode.downstream) {
        if (byFqn.has(d)) {
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
  }

  // 2b. structure fallback: anything the stack DEFINES that neither state
  //     nor the plan produced yet renders as a "not deployed" ghost — the
  //     canvas never shows a blank screen for a defined stack
  if (input.structure !== undefined) {
    const logicalIds = new Map<string, string[]>();
    for (const n of nodes) {
      logicalIds.set(n.logicalId, [
        ...(logicalIds.get(n.logicalId) ?? []),
        n.fqn,
      ]);
    }
    const added: SceneNode[] = [];
    for (const res of input.structure.resources) {
      if (byFqn.has(res.fqn)) {
        continue;
      }
      const node: SceneNode = {
        fqn: res.fqn,
        logicalId: res.logicalId,
        path: res.fqn.split("/").slice(0, -1),
        kind: "resource",
        type: res.type,
        status: "pending",
        bindings: [],
        downstream: [],
      };
      nodes.push(node);
      added.push(node);
      byFqn.set(node.fqn, node);
      logicalIds.set(node.logicalId, [
        ...(logicalIds.get(node.logicalId) ?? []),
        node.fqn,
      ]);
    }
    const seen = new Set(
      edges.map((e) => `${e.kind}:${e.source}->${e.target}`),
    );
    for (const res of input.structure.resources) {
      for (const sid of res.bindingSids) {
        const segments = logicalIds.has(sid) ? [sid] : sid.split(", ");
        for (const segment of segments) {
          for (const target of logicalIds.get(segment) ?? []) {
            const key = `binding:${res.fqn}->${target}`;
            if (!seen.has(key) && res.fqn !== target) {
              seen.add(key);
              edges.push({ source: res.fqn, target, kind: "binding", sid });
            }
          }
        }
      }
    }
  }

  // 3. session overlay: fold apply events in order. Events are keyed by
  //    logicalId — resolve against the assembled node set (all fqns that
  //    share the logicalId; ambiguity applies to each, same as the TUI).
  let session: SceneSession | null = null;
  if (input.session !== undefined) {
    const byLogicalId = new Map<string, SceneNode[]>();
    for (const n of nodes) {
      byLogicalId.set(n.logicalId, [
        ...(byLogicalId.get(n.logicalId) ?? []),
        n,
      ]);
    }
    const feed: SceneFeedEntry[] = [];
    let failed = false;
    for (const { seq, event } of input.session.events) {
      switch (event.kind) {
        case "status-change": {
          const targets = byLogicalId.get(event.id) ?? [];
          if (event.status === "fail") {
            failed = true;
          }
          if (!event.bindingId) {
            const result = TERMINAL[event.status];
            for (const node of targets) {
              node.status = event.status;
              if (result) {
                node.applyResult = result;
              }
            }
          }
          feed.push({
            key: seq,
            id: event.bindingId ? `${event.id}/${event.bindingId}` : event.id,
            text: event.message
              ? `${event.status} — ${event.message}`
              : event.status,
            status: event.status,
          });
          break;
        }
        case "annotate": {
          const targets = byLogicalId.get(event.id) ?? [];
          for (const node of targets) {
            node.note = event.message;
          }
          feed.push({ key: seq, id: event.id, text: event.message });
          break;
        }
        case "log": {
          feed.push({ key: seq, id: event.id, text: event.message, log: true });
          break;
        }
        default:
          // v2 event kinds (op-start / op-end / annotation / future ones)
          // are journal detail the v1 scene doesn't render — skip them.
          break;
      }
    }
    session = {
      id: input.session.sessionId,
      done: input.session.done,
      failed,
      feed,
    };
  }

  // attach deployment timelines (persisted server-side across sessions)
  for (const node of nodes) {
    const timeline = input.timelines.get(node.logicalId);
    if (timeline !== undefined && timeline.length > 0) {
      node.logs = timeline;
    }
  }

  return {
    revision: input.revision,
    stack: input.stack,
    stage: input.stage,
    stages: input.stages,
    nodes,
    edges,
    session,
    approval: input.approvalId !== undefined ? { id: input.approvalId } : null,
    planReady: input.planReady,
    planError: input.planError,
    stateError: input.stateError,
  };
};
