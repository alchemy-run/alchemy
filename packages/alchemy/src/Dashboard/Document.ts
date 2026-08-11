import type { ApplyEvent } from "../Cli/Event.ts";
import type {
  DeploymentEvent,
  DeploymentRecord,
  DeploymentSummary,
} from "../State/Deployment.ts";
import type { DeploymentSessionPayload } from "../State/DeploymentSession.ts";
import type { DashboardPlan } from "./PlanJson.ts";
import type { StackStructure } from "./Scene.ts";

/**
 * Dashboard v2 document core (layer B of the presentation stack).
 *
 * A {@link DeploymentDocument} is the single canonical render document for
 * one `(stack, stage)`: the structural graph (nodes + edges), live
 * decorations, per-resource timelines, the activity feed, lifecycle op
 * spans, the deployment record, annotations, outputs, and approval state.
 *
 * The fold in this module is PURE, framework-free TypeScript:
 * - no IO, no clock — every mutator takes timestamps from its inputs
 * - mutate-in-place (the server owns the document single-threaded)
 * - deterministic: the same inputs always produce the same document
 *
 * Every mutator returns `{ doc, patches }` where `patches` is the minimal
 * {@link DocumentPatch} list describing exactly what changed. When a call
 * changes nothing it returns zero patches and does NOT bump `revision`
 * (so patch-stream consumers never observe a revision gap). When it does
 * change something, `revision` is bumped exactly once for the call and
 * every emitted patch carries that revision.
 *
 * Renderer contract: applying the emitted patch stream to a snapshot clone
 * (see `applyPatch` in `DocumentPatch.ts`) reproduces the mutated document
 * — that property is what the whole transport protocol rests on, and is
 * enforced by `test/Dashboard/Document.test.ts`.
 */

// ─────────────────────────────────────────────────────────────── vocabulary

export type ApplyResult =
  | "created"
  | "updated"
  | "replaced"
  | "deleted"
  | "ran"
  | "retained"
  | "skipped"
  | "failed";

export type PlanAction = "create" | "update" | "replace" | "delete" | "run";

/**
 * Why a node exists in the structure without a persisted-state row:
 * - `"structure"` — defined by the stack file but not deployed yet
 * - `"deleted"` — synthesized from a plan's deletions (teardown display)
 */
export type GhostKind = "structure" | "deleted";

/** Per-resource timelines are capped at this many entries (oldest dropped). */
export const TIMELINE_CAP = 500;

/** The activity feed is capped at this many entries (oldest dropped). */
export const FEED_CAP = 1000;

/**
 * Statuses that mean a lifecycle operation is underway. The FIRST in-flight
 * status a resource reports within a deployment resets its timeline (ported
 * from v1's `recordTimeline` in `Server.ts`).
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "creating",
  "updating",
  "replacing",
  "deleting",
  "creating replacement",
  "pre-creating",
  "running",
]);

/**
 * Terminal status → apply result (ported from v1's `Scene.ts`).
 *
 * COMPLETE over terminal statuses on purpose: decorations merge
 * defined-fields-only and survive across deployments (journal hydration
 * restores the last run's), so any terminal status WITHOUT a mapping
 * would refresh `at` while leaving the previous run's applyResult in
 * place — an action that just RAN would proudly wear the destroy's
 * "deleted" verdict.
 */
export const TERMINAL_RESULTS: Readonly<Record<string, ApplyResult>> = {
  created: "created",
  updated: "updated",
  replaced: "replaced",
  deleted: "deleted",
  ran: "ran",
  retained: "retained",
  skipped: "skipped",
  fail: "failed",
};

// ────────────────────────────────────────────────────────────────── entities

/**
 * One node in the structural graph. Carries the stable identity fields v1's
 * `SceneNode`/`DashboardNode` carried plus the plan/ghost baseline set by
 * the rebuild passes ({@link applyStates}, {@link applyPlan},
 * {@link applyStructure}). Live, event-driven state (status transitions,
 * apply results, notes) lives in {@link Decoration} — events never mutate
 * structure.
 */
export interface DocumentNode {
  fqn: string;
  logicalId: string;
  /** namespace path segments (fqn minus the logical id) */
  path: string[];
  kind: "resource" | "action";
  /** resource type (e.g. "AWS.S3.Bucket") or action type */
  type: string;
  /** baseline status from persisted state (or synthesis) */
  status: string;
  props?: Record<string, any>;
  attrs?: Record<string, any>;
  bindings: { sid: string; data?: any }[];
  downstream: string[];
  /** what the pending/current plan would do (absent for noop) */
  planAction?: PlanAction;
  /** why this node exists without a persisted-state row */
  ghost?: GhostKind;
}

export interface DocumentEdge {
  /**
   * - dependency: `target` consumes an output of `source`
   * - binding: `source` (a Function/Worker host) is bound to `target`
   */
  kind: "dependency" | "binding";
  /** fqn of the source node */
  source: string;
  /** fqn of the target node */
  target: string;
  /** binding sid, for binding edges */
  sid?: string;
}

/** Stable edge identity: `${kind}:${source}->${target}`. */
export const edgeKeyOf = (edge: {
  kind: string;
  source: string;
  target: string;
}): string => `${edge.kind}:${edge.source}->${edge.target}`;

/**
 * Live per-resource overlay driven by apply events. Rendered on top of the
 * structural node — the canvas consumes `structure` + `decorations` and
 * nothing else.
 */
export interface Decoration {
  status?: string;
  planAction?: PlanAction;
  applyResult?: ApplyResult;
  /** latest annotate note from the live apply */
  note?: string;
  /** renderer-side filter dim/hide (never set by the fold itself) */
  hidden?: boolean;
  /** ts of the event that last touched this decoration */
  at: number;
  /**
   * ts of the event that last set `applyResult`. Distinct from `at`
   * deliberately: `at` refreshes on EVERY decorate (status ticks), so a
   * previous run's verdict riding along on fresh in-flight decorations
   * would look current — renderers gate result freshness on THIS.
   */
  resultAt?: number;
}

/** One entry in a resource's deployment timeline. */
export interface TimelineEntry {
  /** epoch millis at emission */
  ts: number;
  /** "status" | "note" | or the log level ("Info", "Error", ...) */
  level: string;
  message: string;
}

/** One entry in the deployment activity feed. */
export interface FeedEntry {
  /** monotonic per-document key (stable renderer identity) */
  key: number;
  /** epoch millis at emission */
  ts: number;
  /** display id — logicalId, `${logicalId}/${bindingId}` for bindings */
  id: string;
  fqn?: string;
  text: string;
  status?: string;
  log?: boolean;
}

/**
 * One provider lifecycle operation, built from `op-start`/`op-end` events
 * plus the preceding `pending` status ts — the Waterfall view's wait/run
 * segments.
 */
export interface OpSpan {
  /** correlates op-start with op-end */
  opId: string;
  /** "precreate" | "create" | "update" | "delete" | "run" ("unknown" when an op-end arrived without its op-start) */
  op: string;
  /** engine phase dispatching the op (e.g. "execute", "gc", "converge") */
  phase?: string;
  /** op-start ts */
  startTs: number;
  /** op-end ts (absent while running) */
  endTs?: number;
  outcome?: "ok" | "fail";
  error?: string;
  /** ts of the resource's preceding `pending` status (the wait segment start) */
  pendingTs?: number;
}

/** Deployment-scoped rich-markdown annotation (upsert by context). */
export interface DocumentAnnotation {
  style: "success" | "info" | "warning" | "error";
  markdown: string;
  at: number;
}

export interface DocumentApproval {
  /** the plan awaiting browser approval (opaque to the document core) */
  plan: unknown;
  requestedAt: number;
}

export interface DocumentMeta {
  stack: string;
  stage: string;
  stages?: string[];
}

export type LiveDeploymentRecord = DeploymentRecord & {
  /** true while the deployment is open (heartbeating) */
  live: boolean;
};

export interface DocumentStructure {
  nodes: Map<string, DocumentNode>;
  edges: Map<string, DocumentEdge>;
  /**
   * Digest of the fqn set + edge-key set ONLY. Changes exactly when the
   * node/edge SETS change — never on decoration or node-field changes — so
   * renderers key layout caches on it and the graph physically cannot move
   * between deploy phases.
   */
  structuralHash: string;
}

export interface DeploymentDocument {
  /** bumped once per mutating fold call; every patch carries it */
  revision: number;
  meta: DocumentMeta;
  structure: DocumentStructure;
  decorations: Map<string, Decoration>;
  timelines: Map<string, TimelineEntry[]>;
  feed: FeedEntry[];
  deployment?: LiveDeploymentRecord;
  annotations: Map<string, DocumentAnnotation>;
  outputs?: unknown;
  approval?: DocumentApproval;
  opSpans: Map<string, OpSpan[]>;
  /** @internal logicalId → fqns index for the event identity join */
  byLogicalId: Map<string, string[]>;
  /**
   * Edges retired with a delete-action node (see {@link applyPlan}) —
   * transient (never serialized): {@link restoreEdges} re-adds them when
   * the post-run ghost rebuild brings the action back, so the topology
   * (and therefore the layout) is identical before and after the run.
   */
  retiredEdges: Map<string, DocumentEdge>;
  /** @internal next feed key */
  feedSeq: number;
  /** @internal fqns whose timeline was reset in the current deployment */
  timelineResets: Set<string>;
  /** @internal fqn → ts of the latest `pending` status (wait-segment start) */
  pendingSince: Map<string, number>;
}

// ─────────────────────────────────────────────────────────────────── patches

export interface StructureReplacePatch {
  kind: "structure-replace";
  revision: number;
  nodes: DocumentNode[];
  edges: DocumentEdge[];
  structuralHash: string;
}

export interface DecoratePatch {
  kind: "decorate";
  revision: number;
  fqn: string;
  status?: string;
  planAction?: PlanAction;
  applyResult?: ApplyResult;
  note?: string;
  hidden?: boolean;
  at: number;
}

export interface TimelineAppendPatch {
  kind: "timeline-append";
  revision: number;
  fqn: string;
  entries: TimelineEntry[];
  /** replace the timeline with `entries` instead of appending */
  reset?: boolean;
}

export interface FeedAppendPatch {
  kind: "feed-append";
  revision: number;
  entries: FeedEntry[];
}

/** Upsert one op span (matched by `opId` within the fqn's span list). */
export interface OpSpanPatch {
  kind: "op-span";
  revision: number;
  fqn: string;
  span: OpSpan;
}

export interface DeploymentPatch {
  kind: "deployment";
  revision: number;
  record: LiveDeploymentRecord;
}

/** A new deployment began: clear op spans + annotations. */
export interface DeploymentResetPatch {
  kind: "deployment-reset";
  revision: number;
}

export interface AnnotationPatch {
  kind: "annotation";
  revision: number;
  context: string;
  style: DocumentAnnotation["style"];
  markdown: string;
  at: number;
}

export interface OutputsPatch {
  kind: "outputs";
  revision: number;
  value: unknown;
}

export interface ApprovalSetPatch {
  kind: "approval-set";
  revision: number;
  plan: unknown;
  requestedAt: number;
}

export interface ApprovalClearPatch {
  kind: "approval-clear";
  revision: number;
}

export interface MetaPatch {
  kind: "meta";
  revision: number;
  stack?: string;
  stage?: string;
  stages?: string[];
}

/**
 * The public wire contract between the document fold and every renderer
 * (web SPA, TUI, native app). Schema-typed in `DocumentPatch.ts`.
 */
export type DocumentPatch =
  | StructureReplacePatch
  | DecoratePatch
  | TimelineAppendPatch
  | FeedAppendPatch
  | OpSpanPatch
  | DeploymentPatch
  | DeploymentResetPatch
  | AnnotationPatch
  | OutputsPatch
  | ApprovalSetPatch
  | ApprovalClearPatch
  | MetaPatch;

// ────────────────────────────────────────────────────────────────── snapshot

/**
 * JSON-serializable full projection of a document (Maps → arrays/records).
 * The transport's connect handshake is snapshot-then-patches.
 */
export interface DocumentSnapshot {
  revision: number;
  meta: DocumentMeta;
  structure: {
    nodes: DocumentNode[];
    edges: DocumentEdge[];
    structuralHash: string;
  };
  decorations: Record<string, Decoration>;
  timelines: Record<string, TimelineEntry[]>;
  feed: FeedEntry[];
  deployment?: LiveDeploymentRecord;
  annotations: Record<string, DocumentAnnotation>;
  outputs?: unknown;
  approval?: DocumentApproval;
  opSpans: Record<string, OpSpan[]>;
}

export const snapshotOf = (doc: DeploymentDocument): DocumentSnapshot =>
  structuredClone({
    revision: doc.revision,
    meta: doc.meta,
    structure: {
      nodes: [...doc.structure.nodes.values()],
      edges: [...doc.structure.edges.values()],
      structuralHash: doc.structure.structuralHash,
    },
    decorations: Object.fromEntries(doc.decorations),
    timelines: Object.fromEntries(doc.timelines),
    feed: doc.feed,
    ...(doc.deployment !== undefined ? { deployment: doc.deployment } : {}),
    annotations: Object.fromEntries(doc.annotations),
    ...(doc.outputs !== undefined ? { outputs: doc.outputs } : {}),
    ...(doc.approval !== undefined ? { approval: doc.approval } : {}),
    opSpans: Object.fromEntries(doc.opSpans),
  });

/**
 * Rebuild a document from a snapshot. Internal fold trackers
 * (`timelineResets`, `pendingSince`) are reset — a rebuilt document is
 * correct for rendering and for applying PATCHES, but a mid-deploy journal
 * re-fold should start from a fresh document + `foldJournal` instead.
 */
export const fromSnapshot = (
  snapshot: DocumentSnapshot,
): DeploymentDocument => {
  const snap = structuredClone(snapshot);
  const doc: DeploymentDocument = {
    revision: snap.revision,
    meta: snap.meta,
    structure: {
      nodes: new Map(snap.structure.nodes.map((n) => [n.fqn, n])),
      edges: new Map(snap.structure.edges.map((e) => [edgeKeyOf(e), e])),
      structuralHash: snap.structure.structuralHash,
    },
    decorations: new Map(Object.entries(snap.decorations)),
    timelines: new Map(Object.entries(snap.timelines)),
    feed: snap.feed,
    ...(snap.deployment !== undefined ? { deployment: snap.deployment } : {}),
    annotations: new Map(Object.entries(snap.annotations)),
    ...(snap.outputs !== undefined ? { outputs: snap.outputs } : {}),
    ...(snap.approval !== undefined ? { approval: snap.approval } : {}),
    opSpans: new Map(Object.entries(snap.opSpans)),
    byLogicalId: new Map(),
    retiredEdges: new Map(),
    feedSeq: snap.feed.reduce((max, e) => Math.max(max, e.key + 1), 0),
    timelineResets: new Set(),
    pendingSince: new Map(),
  };
  reindex(doc);
  return doc;
};

// ─────────────────────────────────────────────────────────────────── helpers

/** The result of every mutator: the same (mutated) doc + minimal patches. */
export interface Mutation {
  doc: DeploymentDocument;
  patches: DocumentPatch[];
}

/** Copy only the defined entries of a partial (drops explicit undefined). */
export const definedOnly = <T extends object>(value: T): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
};

const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** Digest of the fqn set + edge-key set (order-independent). */
export const computeStructuralHash = (structure: {
  nodes: Map<string, DocumentNode>;
  edges: Map<string, DocumentEdge>;
}): string =>
  fnv1a(
    `${[...structure.nodes.keys()].sort().join(",")}|${[...structure.edges.keys()].sort().join(",")}`,
  );

/** Content signature of the whole structure (nodes + edges, key order). */
export const structureSignature = (structure: {
  nodes: Map<string, DocumentNode>;
  edges: Map<string, DocumentEdge>;
}): string =>
  JSON.stringify([
    [...structure.nodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    [...structure.edges.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);

/** Rebuild the logicalId → fqns identity-join index. */
export const reindex = (doc: DeploymentDocument): void => {
  const index = new Map<string, string[]>();
  for (const node of doc.structure.nodes.values()) {
    const fqns = index.get(node.logicalId) ?? [];
    fqns.push(node.fqn);
    index.set(node.logicalId, fqns);
  }
  doc.byLogicalId = index;
};

/**
 * Resolve an event to its target fqn(s): prefer the event's own `fqn`
 * (v2 emitters), fall back to the logicalId index (fan-out to every fqn
 * sharing the logicalId, same as v1), finally to the bare id (root-level
 * fqns ARE their logicalId).
 */
const targetsOf = (
  doc: DeploymentDocument,
  fqn: string | undefined,
  id: string | undefined,
): string[] =>
  fqn !== undefined
    ? [fqn]
    : id !== undefined
      ? (doc.byLogicalId.get(id) ?? [id])
      : [];

/** Stamp the doc revision onto the collected patches (no-op when empty). */
export const commit = (
  doc: DeploymentDocument,
  patches: DocumentPatch[],
): Mutation => {
  if (patches.length > 0) {
    doc.revision += 1;
    for (const patch of patches) {
      patch.revision = doc.revision;
    }
  }
  return { doc, patches };
};

const decorate = (
  doc: DeploymentDocument,
  patches: DocumentPatch[],
  fqn: string,
  fields: Omit<Partial<Decoration>, "at" | "resultAt">,
  at: number,
): void => {
  const defined = definedOnly(fields);
  const existing = doc.decorations.get(fqn);
  doc.decorations.set(fqn, {
    ...existing,
    ...defined,
    at,
    ...("applyResult" in defined ? { resultAt: at } : {}),
  });
  patches.push({ kind: "decorate", revision: 0, fqn, ...defined, at });
};

const appendTimeline = (
  doc: DeploymentDocument,
  patches: DocumentPatch[],
  fqn: string,
  entry: TimelineEntry,
  status?: string,
): void => {
  let reset = false;
  if (
    status !== undefined &&
    IN_FLIGHT_STATUSES.has(status) &&
    !doc.timelineResets.has(fqn)
  ) {
    // the resource's next lifecycle operation began: its timeline restarts
    // (once per deployment — ported from v1's recordTimeline)
    doc.timelineResets.add(fqn);
    doc.timelines.set(fqn, []);
    reset = true;
  }
  const entries = doc.timelines.get(fqn) ?? [];
  entries.push(entry);
  if (entries.length > TIMELINE_CAP) {
    entries.splice(0, entries.length - TIMELINE_CAP);
  }
  doc.timelines.set(fqn, entries);
  const patch: TimelineAppendPatch = {
    kind: "timeline-append",
    revision: 0,
    fqn,
    entries: [{ ...entry }],
  };
  if (reset) {
    patch.reset = true;
  }
  patches.push(patch);
};

const appendFeed = (
  doc: DeploymentDocument,
  patches: DocumentPatch[],
  entry: Omit<FeedEntry, "key">,
): void => {
  const full: FeedEntry = {
    key: doc.feedSeq++,
    ...definedOnly(entry),
  } as FeedEntry;
  doc.feed.push(full);
  if (doc.feed.length > FEED_CAP) {
    doc.feed.splice(0, doc.feed.length - FEED_CAP);
  }
  patches.push({ kind: "feed-append", revision: 0, entries: [{ ...full }] });
};

/**
 * Recompute the structural hash + identity index and emit a
 * `structure-replace` patch when the structure's CONTENT changed since
 * `before` (a {@link structureSignature}). The hash itself only moves when
 * the fqn/edge sets moved.
 */
export const finishStructure = (
  doc: DeploymentDocument,
  before: string,
  patches: DocumentPatch[],
): void => {
  doc.structure.structuralHash = computeStructuralHash(doc.structure);
  reindex(doc);
  if (structureSignature(doc.structure) !== before) {
    patches.push({
      kind: "structure-replace",
      revision: 0,
      nodes: structuredClone([...doc.structure.nodes.values()]),
      edges: structuredClone([...doc.structure.edges.values()]),
      structuralHash: doc.structure.structuralHash,
    });
  }
};

// ──────────────────────────────────────────────────────────────────── fold

/** An empty document for `(stack, stage)`. */
export const makeDocument = (init: DocumentMeta): DeploymentDocument => {
  const doc: DeploymentDocument = {
    revision: 0,
    meta: { ...definedOnly(init) } as DocumentMeta,
    structure: { nodes: new Map(), edges: new Map(), structuralHash: "" },
    decorations: new Map(),
    timelines: new Map(),
    feed: [],
    annotations: new Map(),
    opSpans: new Map(),
    byLogicalId: new Map(),
    retiredEdges: new Map(),
    feedSeq: 0,
    timelineResets: new Set(),
    pendingSince: new Map(),
  };
  doc.structure.structuralHash = computeStructuralHash(doc.structure);
  return doc;
};

/**
 * Overlay a plan: annotate `planAction` on existing nodes and synthesize
 * nodes that exist only in the plan — pending creates AND deletions (a
 * destroy plan has empty `resources` with everything in `deletions`;
 * without synthesis the architecture would vanish instead of showing its
 * teardown). NEVER removes nodes or edges — the union graph across phases
 * is what keeps the canvas from moving; retirement happens only on the
 * next {@link applyStates} rebuild.
 */
export const applyPlan = (
  doc: DeploymentDocument,
  plan: DashboardPlan,
): Mutation => {
  const patches: DocumentPatch[] = [];
  if (!plan.available) {
    return commit(doc, patches);
  }
  const before = structureSignature(doc.structure);
  const nodes = doc.structure.nodes;
  const edges = doc.structure.edges;

  // the plan owns the planAction field: clear stale actions first
  for (const node of nodes.values()) {
    if (node.planAction !== undefined) {
      delete node.planAction;
    }
  }

  // Actions (tasks) are part of the plan too: a "run" task participates
  // in the deployment exactly like a resource (pending -> running -> ran),
  // so it must be visible from the review screen onward — not pop into
  // existence when its terminal status lands at the end of the run. Noop
  // tasks are skipped (their persisted state feeds the baseline). A task
  // being DELETED never runs — its "deletion" is a pure state drop, so it
  // has no place in the review graph or the run display: remove it (the
  // one deliberate exception to this pass's never-removes rule).
  for (const planAction of Object.values(plan.actions ?? {})) {
    if (planAction.action === "noop") {
      continue;
    }
    if (planAction.action === "delete") {
      if (nodes.delete(planAction.fqn)) {
        for (const [key, edge] of edges) {
          if (
            edge.source === planAction.fqn ||
            edge.target === planAction.fqn
          ) {
            // stash for the post-run ghost rebuild (see restoreEdges)
            doc.retiredEdges.set(key, edge);
            edges.delete(key);
          }
        }
      }
      continue;
    }
    let node = nodes.get(planAction.fqn);
    if (node === undefined) {
      node = {
        fqn: planAction.fqn,
        logicalId: planAction.logicalId,
        path: planAction.fqn.split("/").slice(0, -1),
        kind: "action",
        type: planAction.type,
        status: "pending",
        bindings: [],
        downstream: [...planAction.downstream],
      };
      nodes.set(node.fqn, node);
    }
    node.planAction = "run";
  }

  const planNodes = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ];
  for (const planNode of planNodes) {
    let node = nodes.get(planNode.fqn);
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
        downstream: [...planNode.downstream],
      };
      if (planNode.action === "delete") {
        node.ghost = "deleted";
      }
      nodes.set(node.fqn, node);
    }
    if (planNode.action !== "noop") {
      node.planAction = planNode.action;
    }
  }

  // edges contributed by plan-only nodes
  const logicalIds = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const fqns = logicalIds.get(n.logicalId) ?? [];
    fqns.push(n.fqn);
    logicalIds.set(n.logicalId, fqns);
  }
  const push = (edge: DocumentEdge) => {
    const key = edgeKeyOf(edge);
    if (!edges.has(key) && edge.source !== edge.target) {
      edges.set(key, edge);
    }
  };
  for (const planAction of Object.values(plan.actions ?? {})) {
    if (planAction.action !== "run") {
      continue;
    }
    for (const d of planAction.downstream) {
      if (nodes.has(d)) {
        push({ source: planAction.fqn, target: d, kind: "dependency" });
      }
    }
  }
  for (const planNode of planNodes) {
    for (const d of planNode.downstream) {
      if (nodes.has(d)) {
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

  finishStructure(doc, before, patches);
  return commit(doc, patches);
};

/**
 * Ghost fallback pass: anything the stack DEFINES that neither state nor
 * the plan produced yet renders as a "not deployed" ghost — the canvas
 * never shows a blank screen for a defined stack. Additive only.
 */
export const applyStructure = (
  doc: DeploymentDocument,
  structure: StackStructure,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const before = structureSignature(doc.structure);
  const nodes = doc.structure.nodes;
  const edges = doc.structure.edges;

  const logicalIds = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const fqns = logicalIds.get(n.logicalId) ?? [];
    fqns.push(n.fqn);
    logicalIds.set(n.logicalId, fqns);
  }
  for (const res of structure.resources) {
    if (nodes.has(res.fqn)) {
      continue;
    }
    const node: DocumentNode = {
      fqn: res.fqn,
      logicalId: res.logicalId,
      path: res.fqn.split("/").slice(0, -1),
      kind: res.kind ?? "resource",
      type: res.type,
      status: "pending",
      bindings: [],
      downstream: [],
      ghost: "structure",
    };
    nodes.set(node.fqn, node);
    const fqns = logicalIds.get(node.logicalId) ?? [];
    fqns.push(node.fqn);
    logicalIds.set(node.logicalId, fqns);
  }
  for (const res of structure.resources) {
    for (const sid of res.bindingSids) {
      const segments = logicalIds.has(sid) ? [sid] : sid.split(", ");
      for (const segment of segments) {
        for (const target of logicalIds.get(segment) ?? []) {
          const key = `binding:${res.fqn}->${target}`;
          if (!edges.has(key) && res.fqn !== target) {
            edges.set(key, { source: res.fqn, target, kind: "binding", sid });
          }
        }
      }
    }
  }

  finishStructure(doc, before, patches);
  return commit(doc, patches);
};

/**
 * O(1) incremental fold of one live event — apply events (status-change,
 * annotate, log, op-start, op-end, annotation) and journal payloads
 * (deployment-start/end, state-set/delete, output-set). Total over unknown
 * kinds: anything unrecognized is ignored.
 *
 * `at` supplies the timestamp for payloads that don't carry their own `ts`
 * (journal envelopes stamp it — see {@link foldJournal}).
 */

/**
 * Re-add edges (typically captured before an `applyStates` rebuild) whose
 * endpoints still exist. This is what keeps the topology IDENTICAL through
 * a destroy: the states rebuild retires everything, the structure ghost
 * pass re-adds the nodes (bindings only — it cannot know dependency
 * edges), and this restores the dependency edges between surviving nodes
 * so the structural hash — and therefore the layout — does not move.
 */
export const restoreEdges = (
  doc: DeploymentDocument,
  edges: readonly DocumentEdge[],
): Mutation => {
  const patches: DocumentPatch[] = [];
  const before = structureSignature(doc.structure);
  const retired = [...doc.retiredEdges.values()];
  doc.retiredEdges.clear();
  for (const edge of [...edges, ...retired]) {
    const key = edgeKeyOf(edge);
    if (
      !doc.structure.edges.has(key) &&
      doc.structure.nodes.has(edge.source) &&
      doc.structure.nodes.has(edge.target)
    ) {
      doc.structure.edges.set(key, { ...edge });
    }
  }
  finishStructure(doc, before, patches);
  return commit(doc, patches);
};
export const applyEvent = (
  doc: DeploymentDocument,
  event: ApplyEvent | DeploymentSessionPayload,
  at?: number,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const raw = event as { kind?: unknown; ts?: unknown };
  if (typeof raw.kind !== "string") {
    return commit(doc, patches);
  }
  const ts = typeof raw.ts === "number" ? raw.ts : (at ?? 0);

  switch (event.kind) {
    case "deployment-start": {
      doc.timelineResets = new Set();
      doc.pendingSince = new Map();
      if (doc.opSpans.size > 0 || doc.annotations.size > 0) {
        // the previous deployment's op spans and annotations retire
        doc.opSpans = new Map();
        doc.annotations = new Map();
        patches.push({ kind: "deployment-reset", revision: 0 });
      }
      const record: LiveDeploymentRecord = {
        stack: doc.meta.stack,
        stage: doc.meta.stage,
        version: doc.deployment?.version ?? 0,
        meta: { ...doc.deployment?.meta, command: event.command },
        startedAt: ts,
        heartbeatAt: ts,
        live: true,
      };
      doc.deployment = record;
      patches.push({
        kind: "deployment",
        revision: 0,
        record: structuredClone(record),
      });
      break;
    }
    case "deployment-end": {
      const record: LiveDeploymentRecord = doc.deployment ?? {
        stack: doc.meta.stack,
        stage: doc.meta.stage,
        version: 0,
        meta: { command: "deploy" },
        startedAt: ts,
        heartbeatAt: ts,
        live: true,
      };
      record.endedAt = ts;
      record.outcome = event.outcome;
      if (event.summary !== undefined) {
        record.summary = event.summary as DeploymentSummary;
      }
      record.live = false;
      doc.deployment = record;
      patches.push({
        kind: "deployment",
        revision: 0,
        record: structuredClone(record),
      });
      break;
    }
    case "state-set": {
      decorate(doc, patches, event.fqn, { status: event.status }, ts);
      break;
    }
    case "state-delete": {
      decorate(doc, patches, event.fqn, { status: "deleted" }, ts);
      break;
    }
    case "output-set": {
      // the payload carries no value; the host re-reads outputs and calls
      // setOutputs — nothing to fold here
      break;
    }
    case "status-change": {
      const isBinding = event.bindingId !== undefined && event.bindingId !== "";
      const text = event.message
        ? `${event.status} — ${event.message}`
        : event.status;
      if (!isBinding) {
        const result = TERMINAL_RESULTS[event.status];
        for (const fqn of targetsOf(doc, event.fqn, event.id)) {
          decorate(
            doc,
            patches,
            fqn,
            { status: event.status, applyResult: result },
            ts,
          );
          appendTimeline(
            doc,
            patches,
            fqn,
            { ts, level: "status", message: text },
            event.status,
          );
          if (event.status === "pending") {
            doc.pendingSince.set(fqn, ts);
          }
        }
      }
      appendFeed(doc, patches, {
        ts,
        fqn: event.fqn,
        id: isBinding ? `${event.id}/${event.bindingId}` : event.id,
        text,
        status: event.status,
      });
      break;
    }
    case "annotate": {
      for (const fqn of targetsOf(doc, event.fqn, event.id)) {
        decorate(doc, patches, fqn, { note: event.message }, ts);
        appendTimeline(doc, patches, fqn, {
          ts,
          level: "note",
          message: event.message,
        });
      }
      appendFeed(doc, patches, {
        ts,
        fqn: event.fqn,
        id: event.id,
        text: event.message,
      });
      break;
    }
    case "log": {
      for (const fqn of targetsOf(doc, event.fqn, event.id)) {
        appendTimeline(doc, patches, fqn, {
          ts,
          level: event.level,
          message: event.message,
        });
      }
      appendFeed(doc, patches, {
        ts,
        fqn: event.fqn,
        id: event.id,
        text: event.message,
        log: true,
      });
      break;
    }
    case "op-start": {
      for (const fqn of targetsOf(doc, event.fqn, event.id)) {
        const span: OpSpan = { opId: event.opId, op: event.op, startTs: ts };
        if (event.phase !== undefined) {
          span.phase = event.phase;
        }
        const pending = doc.pendingSince.get(fqn);
        if (pending !== undefined && pending <= ts) {
          span.pendingTs = pending;
        }
        const spans = doc.opSpans.get(fqn) ?? [];
        const index = spans.findIndex((s) => s.opId === event.opId);
        if (index >= 0) {
          spans[index] = span;
        } else {
          spans.push(span);
        }
        doc.opSpans.set(fqn, spans);
        patches.push({ kind: "op-span", revision: 0, fqn, span: { ...span } });
      }
      break;
    }
    case "op-end": {
      for (const fqn of targetsOf(doc, event.fqn, event.id)) {
        const spans = doc.opSpans.get(fqn) ?? [];
        let span = spans.find((s) => s.opId === event.opId);
        if (span === undefined) {
          // op-end without op-start (lost/partial journal): tolerate with a
          // zero-length span so the outcome still lands
          span = { opId: event.opId, op: "unknown", startTs: ts };
          spans.push(span);
          doc.opSpans.set(fqn, spans);
        }
        span.endTs = ts;
        span.outcome = event.outcome;
        if (event.error !== undefined) {
          span.error = event.error;
        }
        patches.push({ kind: "op-span", revision: 0, fqn, span: { ...span } });
      }
      break;
    }
    case "annotation": {
      doc.annotations.set(event.context, {
        style: event.style,
        markdown: event.markdown,
        at: ts,
      });
      patches.push({
        kind: "annotation",
        revision: 0,
        context: event.context,
        style: event.style,
        markdown: event.markdown,
        at: ts,
      });
      break;
    }
    default: {
      // unknown/future event kinds: the fold is total — ignore
      break;
    }
  }
  return commit(doc, patches);
};

/** Set/refresh the deployment record (from `DeploymentStore.get`/`list`). */
export const applyDeploymentRecord = (
  doc: DeploymentDocument,
  record: DeploymentRecord,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const live: LiveDeploymentRecord = {
    ...structuredClone(record),
    live: record.endedAt === undefined,
  };
  if (JSON.stringify(doc.deployment) !== JSON.stringify(live)) {
    doc.deployment = live;
    patches.push({
      kind: "deployment",
      revision: 0,
      record: structuredClone(live),
    });
  }
  return commit(doc, patches);
};

/** Set the stack outputs (already encoded — opaque to the document). */
export const setOutputs = (
  doc: DeploymentDocument,
  value: unknown,
): Mutation => {
  const patches: DocumentPatch[] = [];
  if (JSON.stringify(doc.outputs) !== JSON.stringify(value)) {
    doc.outputs = structuredClone(value);
    patches.push({
      kind: "outputs",
      revision: 0,
      value: structuredClone(value),
    });
  }
  return commit(doc, patches);
};

/** A plan is awaiting browser approval. */
export const setApproval = (
  doc: DeploymentDocument,
  approval: DocumentApproval,
): Mutation => {
  const patches: DocumentPatch[] = [];
  doc.approval = {
    plan: structuredClone(approval.plan),
    requestedAt: approval.requestedAt,
  };
  patches.push({
    kind: "approval-set",
    revision: 0,
    plan: structuredClone(approval.plan),
    requestedAt: approval.requestedAt,
  });
  return commit(doc, patches);
};

/** The pending approval was decided or retired. */
export const clearApproval = (doc: DeploymentDocument): Mutation => {
  const patches: DocumentPatch[] = [];
  if (doc.approval !== undefined) {
    delete doc.approval;
    patches.push({ kind: "approval-clear", revision: 0 });
  }
  return commit(doc, patches);
};

/** Update document meta (e.g. the discovered stage list). */
export const setMeta = (
  doc: DeploymentDocument,
  meta: Partial<DocumentMeta>,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const defined = definedOnly(meta);
  const next = { ...doc.meta, ...defined };
  if (JSON.stringify(next) !== JSON.stringify(doc.meta)) {
    doc.meta = next;
    patches.push({ kind: "meta", revision: 0, ...defined });
  }
  return commit(doc, patches);
};

/**
 * Replay a stored journal (from `DeploymentStore.readEvents`) through
 * {@link applyEvent} — how history views and mid-deploy catch-up hydrate.
 * Envelope `ts`/`fqn` fill in for payloads that don't carry their own.
 * Total: malformed payloads are skipped.
 */
export const foldJournal = (
  doc: DeploymentDocument,
  events: readonly DeploymentEvent[],
): Mutation => {
  const patches: DocumentPatch[] = [];
  for (const envelope of events) {
    const payload = envelope.payload;
    if (payload === null || typeof payload !== "object") {
      continue;
    }
    const event = payload as ApplyEvent | DeploymentSessionPayload;
    if (typeof (event as { kind?: unknown }).kind !== "string") {
      continue;
    }
    const eventFqn = (event as { fqn?: string }).fqn;
    const enriched =
      eventFqn === undefined && envelope.fqn !== undefined
        ? ({ ...event, fqn: envelope.fqn } as
            | ApplyEvent
            | DeploymentSessionPayload)
        : event;
    const result = applyEvent(doc, enriched, envelope.ts);
    for (const patch of result.patches) {
      patches.push(patch);
    }
  }
  return { doc, patches };
};
