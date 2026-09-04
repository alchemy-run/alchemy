import {
  IN_FLIGHT_STATUSES,
  type ApplyResult,
  type DeploymentDocument,
  type DocumentAnnotation,
  type PlanAction,
  type TimelineEntry,
} from "./Document.ts";

/**
 * Pure view projections of a {@link DeploymentDocument} — Summary, List,
 * Table, Waterfall, and Annotations render identically in the web SPA, a
 * TUI, or a native app because this logic exists ONCE, here. (Canvas
 * consumes `doc.structure` + `doc.decorations` directly.)
 */

// ──────────────────────────────────────────────────────────────── annotations

export interface AnnotationView extends DocumentAnnotation {
  context: string;
}

/**
 * The deployment's annotations in insertion order (upserting an existing
 * context keeps its original position — Buildkite semantics).
 */
export const annotationsOf = (doc: DeploymentDocument): AnnotationView[] =>
  [...doc.annotations.entries()].map(([context, a]) => ({ context, ...a }));

// ─────────────────────────────────────────────────────────────────── summary

export interface SummaryDeploymentView {
  version: number;
  command: "deploy" | "destroy";
  initiator?: { user?: string; host?: string; pid?: number };
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  outcome?: string;
  live: boolean;
}

export interface SummaryFailureView {
  fqn: string;
  error?: string;
  timelineTail: TimelineEntry[];
}

export interface SummaryView {
  deployment?: SummaryDeploymentView;
  counts: {
    byPlanAction: Record<string, number>;
    byApplyResult: Record<string, number>;
  };
  outputs?: unknown;
  annotations: AnnotationView[];
  failures: SummaryFailureView[];
}

const TIMELINE_TAIL = 5;

export const summaryOf = (doc: DeploymentDocument): SummaryView => {
  const byPlanAction: Record<string, number> = {};
  for (const node of doc.structure.nodes.values()) {
    if (node.planAction !== undefined) {
      byPlanAction[node.planAction] = (byPlanAction[node.planAction] ?? 0) + 1;
    }
  }
  // Only the CURRENT run's verdicts count — a previous run's applyResult
  // survives in the decoration (defined-fields merge) and must not inflate
  // this run's progress or failures. `resultAt` stamps when the verdict
  // itself landed (`at` refreshes on every status tick).
  const startedAt = doc.deployment?.startedAt;
  const resultIsCurrent = (decoration: {
    resultAt?: number;
    at: number;
  }): boolean =>
    startedAt === undefined || (decoration.resultAt ?? 0) >= startedAt;
  const byApplyResult: Record<string, number> = {};
  for (const decoration of doc.decorations.values()) {
    if (decoration.applyResult !== undefined && resultIsCurrent(decoration)) {
      byApplyResult[decoration.applyResult] =
        (byApplyResult[decoration.applyResult] ?? 0) + 1;
    }
  }

  const failedFqns = new Set<string>();
  for (const [fqn, decoration] of doc.decorations) {
    if (
      (decoration.applyResult === "failed" && resultIsCurrent(decoration)) ||
      decoration.status === "fail"
    ) {
      failedFqns.add(fqn);
    }
  }
  for (const [fqn, spans] of doc.opSpans) {
    if (spans.some((s) => s.outcome === "fail")) {
      failedFqns.add(fqn);
    }
  }
  const failures: SummaryFailureView[] = [...failedFqns].sort().map((fqn) => {
    const spans = doc.opSpans.get(fqn) ?? [];
    const failedSpan = [...spans].reverse().find((s) => s.outcome === "fail");
    const failure: SummaryFailureView = {
      fqn,
      timelineTail: (doc.timelines.get(fqn) ?? []).slice(-TIMELINE_TAIL),
    };
    if (failedSpan?.error !== undefined) {
      failure.error = failedSpan.error;
    }
    return failure;
  });

  const view: SummaryView = {
    counts: { byPlanAction, byApplyResult },
    annotations: annotationsOf(doc),
    failures,
  };
  if (doc.deployment !== undefined) {
    const d = doc.deployment;
    view.deployment = {
      version: d.version,
      command: d.meta.command,
      ...(d.meta.initiator !== undefined
        ? { initiator: d.meta.initiator }
        : {}),
      startedAt: d.startedAt,
      ...(d.endedAt !== undefined
        ? { endedAt: d.endedAt, durationMs: d.endedAt - d.startedAt }
        : {}),
      ...(d.outcome !== undefined ? { outcome: d.outcome } : {}),
      live: d.live,
    };
  }
  if (doc.outputs !== undefined) {
    view.outputs = doc.outputs;
  }
  return view;
};

// ────────────────────────────────────────────────────────────────────── list

export type ListGroup =
  | "failed"
  | "in-flight"
  | "pending"
  | "completed"
  | "other";

/** Pipeline display order for the List view's status groups. */
export const LIST_GROUP_ORDER: readonly ListGroup[] = [
  "failed",
  "in-flight",
  "pending",
  "completed",
  "other",
];

const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "updated",
  "adopted",
  "replaced",
  "deleted",
  "orphaned",
  "ran",
  "skipped",
]);

export interface ListNodeView {
  fqn: string;
  logicalId: string;
  type: string;
  /** effective status: live decoration over the persisted baseline */
  status: string;
  planAction?: PlanAction;
  applyResult?: ApplyResult;
  note?: string;
}

export interface ListGroupView {
  group: ListGroup;
  nodes: ListNodeView[];
}

/** Structure nodes grouped by effective status/result, pipeline order. */
export const listGroupsOf = (doc: DeploymentDocument): ListGroupView[] => {
  const buckets = new Map<ListGroup, ListNodeView[]>();
  const sorted = [...doc.structure.nodes.values()].sort((a, b) =>
    a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0,
  );
  for (const node of sorted) {
    const decoration = doc.decorations.get(node.fqn);
    const status = decoration?.status ?? node.status;
    const group: ListGroup =
      decoration?.applyResult === "failed" || status === "fail"
        ? "failed"
        : IN_FLIGHT_STATUSES.has(status)
          ? "in-flight"
          : status === "pending" || status === "waiting"
            ? "pending"
            : COMPLETED_STATUSES.has(status)
              ? "completed"
              : "other";
    const row: ListNodeView = {
      fqn: node.fqn,
      logicalId: node.logicalId,
      type: node.type,
      status,
    };
    const planAction = node.planAction ?? decoration?.planAction;
    if (planAction !== undefined) row.planAction = planAction;
    if (decoration?.applyResult !== undefined) {
      row.applyResult = decoration.applyResult;
    }
    if (decoration?.note !== undefined) row.note = decoration.note;
    const bucket = buckets.get(group) ?? [];
    bucket.push(row);
    buckets.set(group, bucket);
  }
  return LIST_GROUP_ORDER.filter((group) => buckets.has(group)).map(
    (group) => ({ group, nodes: buckets.get(group)! }),
  );
};

// ───────────────────────────────────────────────────────────────────── table

export interface TableRowView {
  fqn: string;
  type?: string;
  status: string;
  planAction?: PlanAction;
  applyResult?: ApplyResult;
  /** `pending` status → first op-start (Buildkite wait time) */
  waitMs?: number;
  /** total op-start → op-end across completed lifecycle ops */
  runMs?: number;
}

/** One sortable row per known fqn (structure ∪ decorations ∪ op spans). */
export const tableRowsOf = (doc: DeploymentDocument): TableRowView[] => {
  const fqns = new Set<string>([
    ...doc.structure.nodes.keys(),
    ...doc.decorations.keys(),
    ...doc.opSpans.keys(),
  ]);
  return [...fqns].sort().map((fqn) => {
    const node = doc.structure.nodes.get(fqn);
    const decoration = doc.decorations.get(fqn);
    const spans = doc.opSpans.get(fqn) ?? [];
    const row: TableRowView = {
      fqn,
      status: decoration?.status ?? node?.status ?? "unknown",
    };
    if (node?.type !== undefined) row.type = node.type;
    const planAction = node?.planAction ?? decoration?.planAction;
    if (planAction !== undefined) row.planAction = planAction;
    if (decoration?.applyResult !== undefined) {
      row.applyResult = decoration.applyResult;
    }
    const firstWaited = [...spans]
      .filter((s) => s.pendingTs !== undefined)
      .sort((a, b) => a.startTs - b.startTs)[0];
    if (firstWaited !== undefined) {
      row.waitMs = firstWaited.startTs - firstWaited.pendingTs!;
    }
    const completed = spans.filter((s) => s.endTs !== undefined);
    if (completed.length > 0) {
      row.runMs = completed.reduce(
        (total, s) => total + (s.endTs! - s.startTs),
        0,
      );
    }
    return row;
  });
};

// ───────────────────────────────────────────────────────────────── waterfall

export interface WaterfallSegment {
  kind: "wait" | "run";
  startTs: number;
  /** absent while the op is still running */
  endTs?: number;
  /** run segments only */
  outcome?: "ok" | "fail";
  /** run segments only: the lifecycle op */
  op?: string;
}

export interface WaterfallRowView {
  fqn: string;
  segments: WaterfallSegment[];
}

/**
 * Per-resource bars on a shared time axis: a wait segment (`pending` →
 * op-start) followed by a run segment per lifecycle op, sorted by first ts.
 */
export const waterfallSpansOf = (
  doc: DeploymentDocument,
): WaterfallRowView[] => {
  const rows: WaterfallRowView[] = [];
  for (const [fqn, spans] of doc.opSpans) {
    const segments: WaterfallSegment[] = [];
    for (const span of [...spans].sort((a, b) => a.startTs - b.startTs)) {
      if (span.pendingTs !== undefined && span.pendingTs < span.startTs) {
        segments.push({
          kind: "wait",
          startTs: span.pendingTs,
          endTs: span.startTs,
        });
      }
      const run: WaterfallSegment = {
        kind: "run",
        startTs: span.startTs,
        op: span.op,
      };
      if (span.endTs !== undefined) run.endTs = span.endTs;
      if (span.outcome !== undefined) run.outcome = span.outcome;
      segments.push(run);
    }
    if (segments.length > 0) {
      rows.push({ fqn, segments });
    }
  }
  rows.sort(
    (a, b) =>
      a.segments[0].startTs - b.segments[0].startTs ||
      (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0),
  );
  return rows;
};
