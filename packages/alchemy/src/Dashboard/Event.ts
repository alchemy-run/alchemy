import type { ApplyEvent } from "../Report.ts";
import type { ProviderMode } from "../ProviderMode.ts";
import type {
  DeploymentEndOutcome,
  DeploymentMeta,
  DeploymentSummary,
} from "./History.ts";

/**
 * The dashboard's event vocabulary — everything the document fold
 * ({@link import("./Document.ts").applyEvent}) understands.
 *
 * Two sources feed it:
 *
 * - **Live apply events** from the engine's reporting contract
 *   (`Report.ts`'s {@link ApplyEvent}), adapted by {@link fromApplyEvent} in
 *   the reporter tee before they are posted to the dashboard server. The
 *   engine's `_tag`-discriminated events become `status-change` /
 *   `annotate` / `log` events stamped with an emission timestamp.
 * - **Journal payloads** from a deployment-history store
 *   ({@link import("./History.ts").DeploymentHistory}): the deployment
 *   bookends and status-level state-write records a journaling engine
 *   writes alongside apply events.
 *
 * The richer kinds (`op-start` / `op-end` / `annotation`) are part of the
 * vocabulary so the Waterfall/Table projections and deployment-scoped
 * annotations have a wire shape today; the engine does not emit them yet.
 * The fold is total over unknown kinds, so the vocabulary can grow without
 * breaking older documents.
 */
export interface DashboardEventBase {
  /**
   * Epoch millis at emission (not receipt). Absent on journal payloads,
   * whose envelope carries the timestamp instead.
   */
  ts?: number;
  /**
   * Fully-qualified resource name. The engine stamps it on every apply
   * event; journal payloads that lack it fall back to the envelope's `fqn`,
   * and the fold finally joins through the logicalId index.
   */
  fqn?: string;
}

export interface StatusChangeEvent extends DashboardEventBase {
  kind: "status-change";
  /** resource id (e.g. "messages", "api") */
  id: string;
  /** resource type (e.g. "AWS.S3.Bucket", "Cloudflare.Worker") */
  type: string;
  status: string;
  message?: string;
  /**
   * Set when the event is for a binding on the resource (journal payloads
   * from older engines; the current engine reports per resource only).
   */
  bindingId?: string;
  providerMode?: ProviderMode;
  fromProviderMode?: ProviderMode;
}

export interface AnnotateEvent extends DashboardEventBase {
  kind: "annotate";
  id: string;
  message: string;
}

/**
 * A log line attributed to the resource being applied — verbatim tool
 * output streamed by a provider, or an `Effect.log*` line captured during a
 * lifecycle operation.
 */
export interface LogEvent extends DashboardEventBase {
  kind: "log";
  id: string;
  level: string;
  message: string;
}

/**
 * A provider lifecycle operation began. Paired with {@link OpEndEvent} by
 * `opId` — the ts pair is exactly the Waterfall view's run segment.
 */
export interface OpStartEvent extends DashboardEventBase {
  kind: "op-start";
  id: string;
  /** Correlates this start with its {@link OpEndEvent}. */
  opId: string;
  op: "precreate" | "create" | "update" | "delete" | "run";
  /** Engine phase dispatching the op (e.g. "execute", "gc", "converge"). */
  phase?: string;
}

/** A provider lifecycle operation finished. See {@link OpStartEvent}. */
export interface OpEndEvent extends DashboardEventBase {
  kind: "op-end";
  id: string;
  opId: string;
  outcome: "ok" | "fail";
  error?: string;
}

/**
 * A deployment-scoped rich-markdown annotation (Buildkite semantics: upsert
 * by `context`). Distinct from per-resource {@link AnnotateEvent} notes —
 * `id`/`fqn` are optional and only set for resource-scoped annotations.
 */
export interface AnnotationEvent extends DashboardEventBase {
  kind: "annotation";
  id?: string;
  /** Upsert key: emitting the same context again replaces the annotation. */
  context: string;
  style: "success" | "info" | "warning" | "error";
  markdown: string;
}

/** Journal payload for the session-lifecycle bookends. */
export interface DeploymentStartEvent extends DashboardEventBase {
  kind: "deployment-start";
  command: DeploymentMeta["command"];
}

export interface DeploymentEndEvent extends DashboardEventBase {
  kind: "deployment-end";
  outcome: DeploymentEndOutcome;
  summary?: DeploymentSummary;
}

/**
 * Journal payload for an engine state write. Carries ONLY status-level
 * info (never full props/attr bodies — those live in head state) plus a
 * `before` snapshot of the prior status when a row existed.
 */
export interface StateSetEvent extends DashboardEventBase {
  kind: "state-set";
  fqn: string;
  status: string;
  before?: { status: string };
}

export interface StateDeleteEvent extends DashboardEventBase {
  kind: "state-delete";
  fqn: string;
  before?: { status: string };
}

/** The stack output was (re)written; the host re-reads it. */
export interface OutputSetEvent extends DashboardEventBase {
  kind: "output-set";
}

export type DashboardEvent =
  | StatusChangeEvent
  | AnnotateEvent
  | LogEvent
  | OpStartEvent
  | OpEndEvent
  | AnnotationEvent
  | DeploymentStartEvent
  | DeploymentEndEvent
  | StateSetEvent
  | StateDeleteEvent
  | OutputSetEvent;

/**
 * Adapt one engine {@link ApplyEvent} to the dashboard vocabulary, stamping
 * `ts` (epoch millis) at emission.
 *
 * - `apply.resource.status` → {@link StatusChangeEvent}
 * - `apply.resource.note` → {@link AnnotateEvent}, except verbatim tool
 *   output (`kind: "output"`), which is streamed as a {@link LogEvent} so it
 *   lands in the resource's timeline instead of replacing its note.
 */
export const fromApplyEvent = (
  event: ApplyEvent,
  ts: number,
): DashboardEvent => {
  switch (event._tag) {
    case "apply.resource.status": {
      const out: StatusChangeEvent = {
        kind: "status-change",
        ts,
        fqn: event.fqn,
        id: event.id,
        type: event.type,
        status: event.status,
      };
      if (event.message !== undefined) out.message = event.message;
      if (event.providerMode !== undefined) {
        out.providerMode = event.providerMode;
      }
      if (event.fromProviderMode !== undefined) {
        out.fromProviderMode = event.fromProviderMode;
      }
      return out;
    }
    case "apply.resource.note": {
      if (event.kind === "output") {
        return {
          kind: "log",
          ts,
          fqn: event.fqn,
          id: event.id,
          level: "output",
          message: event.message,
        };
      }
      return {
        kind: "annotate",
        ts,
        fqn: event.fqn,
        id: event.id,
        message: event.message,
      };
    }
  }
};
