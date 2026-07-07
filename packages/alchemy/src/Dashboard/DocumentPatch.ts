import * as S from "effect/Schema";
import {
  edgeKeyOf,
  FEED_CAP,
  reindex,
  TIMELINE_CAP,
  type DeploymentDocument,
  type DocumentPatch,
} from "./Document.ts";

/**
 * The Schema-typed wire contract for dashboard v2: {@link DocumentPatchSchema}
 * (the typed patch stream) and {@link DocumentSnapshotSchema} (the connect
 * handshake's full snapshot), plus {@link applyPatch} — the client-side
 * reducer every renderer (web SPA, TUI, native app) uses to keep a local
 * {@link DeploymentDocument} in sync.
 *
 * Protocol semantics:
 * - connect = snapshot, then patches
 * - every patch carries `revision`; several patches may share one revision
 *   (they came from one fold call) — apply them all
 * - a revision GAP (`patch.revision > doc.revision + 1` across fold-call
 *   boundaries) means the client missed patches → request a fresh snapshot
 * - `applyPatch(fromSnapshot(snapshotOf(doc)), …stream)` reproduces the
 *   server's document exactly (enforced by `test/Dashboard/Document.test.ts`)
 */

// ─────────────────────────────────────────────────────────────────── schemas

export const DocumentNodeSchema = S.Struct({
  fqn: S.String,
  logicalId: S.String,
  path: S.Array(S.String),
  kind: S.Literals(["resource", "action"]),
  type: S.String,
  status: S.String,
  props: S.optional(S.Record(S.String, S.Unknown)),
  attrs: S.optional(S.Record(S.String, S.Unknown)),
  bindings: S.Array(S.Struct({ sid: S.String, data: S.optional(S.Unknown) })),
  downstream: S.Array(S.String),
  planAction: S.optional(S.Literals(["create", "update", "replace", "delete"])),
  ghost: S.optional(S.Literals(["structure", "deleted"])),
});

export const DocumentEdgeSchema = S.Struct({
  kind: S.Literals(["dependency", "binding"]),
  source: S.String,
  target: S.String,
  sid: S.optional(S.String),
});

export const DecorationSchema = S.Struct({
  status: S.optional(S.String),
  planAction: S.optional(S.Literals(["create", "update", "replace", "delete"])),
  applyResult: S.optional(
    S.Literals([
      "created",
      "updated",
      "replaced",
      "deleted",
      "ran",
      "retained",
      "skipped",
      "failed",
    ]),
  ),
  note: S.optional(S.String),
  hidden: S.optional(S.Boolean),
  at: S.Number,
});

export const TimelineEntrySchema = S.Struct({
  ts: S.Number,
  level: S.String,
  message: S.String,
});

export const FeedEntrySchema = S.Struct({
  key: S.Number,
  ts: S.Number,
  id: S.String,
  fqn: S.optional(S.String),
  text: S.String,
  status: S.optional(S.String),
  log: S.optional(S.Boolean),
});

export const OpSpanSchema = S.Struct({
  opId: S.String,
  op: S.String,
  phase: S.optional(S.String),
  startTs: S.Number,
  endTs: S.optional(S.Number),
  outcome: S.optional(S.Literals(["ok", "fail"])),
  error: S.optional(S.String),
  pendingTs: S.optional(S.Number),
});

export const DocumentAnnotationSchema = S.Struct({
  style: S.Literals(["success", "info", "warning", "error"]),
  markdown: S.String,
  at: S.Number,
});

export const DeploymentMetaSchema = S.Struct({
  command: S.Literals(["deploy", "destroy"]),
  initiator: S.optional(
    S.Struct({
      user: S.optional(S.String),
      host: S.optional(S.String),
      pid: S.optional(S.Number),
    }),
  ),
  alchemyVersion: S.optional(S.String),
  gitCommit: S.optional(S.String),
});

export const LiveDeploymentRecordSchema = S.Struct({
  stack: S.String,
  stage: S.String,
  version: S.Number,
  meta: DeploymentMetaSchema,
  startedAt: S.Number,
  heartbeatAt: S.Number,
  endedAt: S.optional(S.Number),
  outcome: S.optional(
    S.Literals([
      "succeeded",
      "failed",
      "interrupted",
      "abandoned",
      "completed-late",
    ]),
  ),
  summary: S.optional(
    S.Struct({
      counts: S.optional(S.Record(S.String, S.Number)),
      error: S.optional(S.String),
    }),
  ),
  live: S.Boolean,
});

export const DocumentMetaSchema = S.Struct({
  stack: S.String,
  stage: S.String,
  stages: S.optional(S.Array(S.String)),
});

const revision = { revision: S.Number };

export const StructureReplacePatchSchema = S.Struct({
  kind: S.Literal("structure-replace"),
  ...revision,
  nodes: S.Array(DocumentNodeSchema),
  edges: S.Array(DocumentEdgeSchema),
  structuralHash: S.String,
});

export const DecoratePatchSchema = S.Struct({
  kind: S.Literal("decorate"),
  ...revision,
  fqn: S.String,
  status: S.optional(S.String),
  planAction: S.optional(S.Literals(["create", "update", "replace", "delete"])),
  applyResult: S.optional(
    S.Literals([
      "created",
      "updated",
      "replaced",
      "deleted",
      "ran",
      "retained",
      "skipped",
      "failed",
    ]),
  ),
  note: S.optional(S.String),
  hidden: S.optional(S.Boolean),
  at: S.Number,
});

export const TimelineAppendPatchSchema = S.Struct({
  kind: S.Literal("timeline-append"),
  ...revision,
  fqn: S.String,
  entries: S.Array(TimelineEntrySchema),
  reset: S.optional(S.Boolean),
});

export const FeedAppendPatchSchema = S.Struct({
  kind: S.Literal("feed-append"),
  ...revision,
  entries: S.Array(FeedEntrySchema),
});

export const OpSpanPatchSchema = S.Struct({
  kind: S.Literal("op-span"),
  ...revision,
  fqn: S.String,
  span: OpSpanSchema,
});

export const DeploymentPatchSchema = S.Struct({
  kind: S.Literal("deployment"),
  ...revision,
  record: LiveDeploymentRecordSchema,
});

export const DeploymentResetPatchSchema = S.Struct({
  kind: S.Literal("deployment-reset"),
  ...revision,
});

export const AnnotationPatchSchema = S.Struct({
  kind: S.Literal("annotation"),
  ...revision,
  context: S.String,
  style: S.Literals(["success", "info", "warning", "error"]),
  markdown: S.String,
  at: S.Number,
});

export const OutputsPatchSchema = S.Struct({
  kind: S.Literal("outputs"),
  ...revision,
  value: S.Unknown,
});

export const ApprovalSetPatchSchema = S.Struct({
  kind: S.Literal("approval-set"),
  ...revision,
  plan: S.Unknown,
  requestedAt: S.Number,
});

export const ApprovalClearPatchSchema = S.Struct({
  kind: S.Literal("approval-clear"),
  ...revision,
});

export const MetaPatchSchema = S.Struct({
  kind: S.Literal("meta"),
  ...revision,
  stack: S.optional(S.String),
  stage: S.optional(S.String),
  stages: S.optional(S.Array(S.String)),
});

/** The public, versioned patch wire contract (see module doc). */
export const DocumentPatchSchema = S.Union([
  StructureReplacePatchSchema,
  DecoratePatchSchema,
  TimelineAppendPatchSchema,
  FeedAppendPatchSchema,
  OpSpanPatchSchema,
  DeploymentPatchSchema,
  DeploymentResetPatchSchema,
  AnnotationPatchSchema,
  OutputsPatchSchema,
  ApprovalSetPatchSchema,
  ApprovalClearPatchSchema,
  MetaPatchSchema,
]);

/** The full-document snapshot sent on connect (Maps → arrays/records). */
export const DocumentSnapshotSchema = S.Struct({
  revision: S.Number,
  meta: DocumentMetaSchema,
  structure: S.Struct({
    nodes: S.Array(DocumentNodeSchema),
    edges: S.Array(DocumentEdgeSchema),
    structuralHash: S.String,
  }),
  decorations: S.Record(S.String, DecorationSchema),
  timelines: S.Record(S.String, S.Array(TimelineEntrySchema)),
  feed: S.Array(FeedEntrySchema),
  deployment: S.optional(LiveDeploymentRecordSchema),
  annotations: S.Record(S.String, DocumentAnnotationSchema),
  outputs: S.optional(S.Unknown),
  approval: S.optional(S.Struct({ plan: S.Unknown, requestedAt: S.Number })),
  opSpans: S.Record(S.String, S.Array(OpSpanSchema)),
});

// ────────────────────────────────────────────────────────── patch application

/**
 * Apply one patch to a document (mutate-in-place). This is the renderer-side
 * reducer: identical cap/merge semantics to the fold, so a snapshot plus the
 * patch stream reproduces the server's document exactly.
 */
export const applyPatch = (
  doc: DeploymentDocument,
  patch: DocumentPatch,
): DeploymentDocument => {
  switch (patch.kind) {
    case "structure-replace": {
      doc.structure.nodes = new Map(
        patch.nodes.map((n) => [n.fqn, structuredClone(n)]),
      );
      doc.structure.edges = new Map(
        patch.edges.map((e) => [edgeKeyOf(e), structuredClone(e)]),
      );
      doc.structure.structuralHash = patch.structuralHash;
      reindex(doc);
      break;
    }
    case "decorate": {
      const existing = doc.decorations.get(patch.fqn);
      const next = { ...existing, at: patch.at };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.planAction !== undefined) next.planAction = patch.planAction;
      if (patch.applyResult !== undefined) next.applyResult = patch.applyResult;
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.hidden !== undefined) next.hidden = patch.hidden;
      doc.decorations.set(patch.fqn, next);
      break;
    }
    case "timeline-append": {
      const entries = patch.reset ? [] : (doc.timelines.get(patch.fqn) ?? []);
      for (const entry of patch.entries) {
        entries.push({ ...entry });
      }
      if (entries.length > TIMELINE_CAP) {
        entries.splice(0, entries.length - TIMELINE_CAP);
      }
      doc.timelines.set(patch.fqn, entries);
      break;
    }
    case "feed-append": {
      for (const entry of patch.entries) {
        doc.feed.push({ ...entry });
        doc.feedSeq = Math.max(doc.feedSeq, entry.key + 1);
      }
      if (doc.feed.length > FEED_CAP) {
        doc.feed.splice(0, doc.feed.length - FEED_CAP);
      }
      break;
    }
    case "op-span": {
      const spans = doc.opSpans.get(patch.fqn) ?? [];
      const span = { ...patch.span };
      const index = spans.findIndex((s) => s.opId === span.opId);
      if (index >= 0) {
        spans[index] = span;
      } else {
        spans.push(span);
      }
      doc.opSpans.set(patch.fqn, spans);
      break;
    }
    case "deployment": {
      doc.deployment = structuredClone(patch.record);
      break;
    }
    case "deployment-reset": {
      doc.opSpans = new Map();
      doc.annotations = new Map();
      doc.timelineResets = new Set();
      doc.pendingSince = new Map();
      break;
    }
    case "annotation": {
      doc.annotations.set(patch.context, {
        style: patch.style,
        markdown: patch.markdown,
        at: patch.at,
      });
      break;
    }
    case "outputs": {
      doc.outputs = structuredClone(patch.value);
      break;
    }
    case "approval-set": {
      doc.approval = {
        plan: structuredClone(patch.plan),
        requestedAt: patch.requestedAt,
      };
      break;
    }
    case "approval-clear": {
      delete doc.approval;
      break;
    }
    case "meta": {
      if (patch.stack !== undefined) doc.meta.stack = patch.stack;
      if (patch.stage !== undefined) doc.meta.stage = patch.stage;
      if (patch.stages !== undefined) doc.meta.stages = [...patch.stages];
      break;
    }
  }
  doc.revision = patch.revision;
  return doc;
};

/** Apply a patch stream in order. */
export const applyPatches = (
  doc: DeploymentDocument,
  patches: readonly DocumentPatch[],
): DeploymentDocument => {
  for (const patch of patches) {
    applyPatch(doc, patch);
  }
  return doc;
};
