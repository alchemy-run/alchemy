import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ProviderMode } from "../ProviderMode.ts";

export type ApplyStatus =
  | "attaching"
  | "post-attach"
  | "pending"
  | "pre-creating"
  | "creating"
  | "creating replacement"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "retained"
  | "replacing"
  | "replaced"
  // Action lifecycle (see {@link Action})
  | "running"
  | "ran"
  | "skipped"
  | "fail";

export type ApplyEvent =
  | AnnotateEvent
  | StatusChangeEvent
  | LogEvent
  | OpStartEvent
  | OpEndEvent
  | AnnotationEvent;

/**
 * The v2 event envelope: fields stamped by the engine on EVERY apply event.
 *
 * Consumers that predate these fields (LoggingCli, the TUI, the v1
 * dashboard) ignore them safely; new consumers (the deployment journal,
 * dashboard v2) rely on them for durable, time-ordered history.
 */
export interface ApplyEventBase {
  /**
   * Epoch millis at emission (not receipt). Stamped by the engine via
   * `Clock.currentTimeMillis` — see {@link stampApplyEvent}.
   */
  ts: number;
  /**
   * Fully-qualified resource name — the primary identity for v2 consumers
   * (`id`/logicalId is not unique across namespaces). Optional: emit sites
   * that don't know the fqn leave it undefined; renderers keying by fqn
   * must fall back to `id`.
   */
  fqn?: string;
}

export interface AnnotateEvent extends ApplyEventBase {
  kind: "annotate";
  id: string;
  message: string;
}

/**
 * A log line (`Effect.log*`) captured during a resource's lifecycle
 * operation, attributed to the resource being applied. Emitted by the
 * per-resource logger `apply()` injects around each lifecycle call —
 * renderers that don't care (LoggingCli, TUI) ignore these; the dashboard
 * shows them per-resource.
 */
export interface LogEvent extends ApplyEventBase {
  kind: "log";
  id: string;
  level: string;
  message: string;
}

export interface StatusChangeEvent extends ApplyEventBase {
  kind: "status-change";
  id: string; // resource id (e.g. "messages", "api")
  type: string; // resource type (e.g. "AWS::Lambda::Function", "Cloudflare::Worker")
  status: ApplyStatus;
  message?: string; // optional details
  bindingId?: string; // if this event is for a binding
  /**
   * The {@link ProviderMode} this node's provider was resolved for.
   * `undefined` for mode-agnostic providers (a single implementation serves
   * both dev and deploy) and for actions — renderers show nothing special.
   */
  providerMode?: ProviderMode;
  /**
   * Set only on mode-switch replacements (local ⇄ live): the mode the OLD
   * generation was created with, so renderers can annotate the transition
   * (e.g. `local → live`). Always differs from `providerMode` when set.
   */
  fromProviderMode?: ProviderMode;
}

/**
 * A provider lifecycle operation began. Emitted from `instrumentLifecycle`
 * (the single dispatch choke point), paired with {@link OpEndEvent} by
 * `opId` — the ts pair is exactly the Waterfall view's run segment.
 */
export interface OpStartEvent extends ApplyEventBase {
  kind: "op-start";
  id: string;
  /** Correlates this start with its {@link OpEndEvent}. */
  opId: string;
  op: "precreate" | "create" | "update" | "delete" | "run";
  /** Engine phase dispatching the op (e.g. "execute", "gc", "converge"). */
  phase?: string;
}

/** A provider lifecycle operation finished. See {@link OpStartEvent}. */
export interface OpEndEvent extends ApplyEventBase {
  kind: "op-end";
  id: string;
  opId: string;
  outcome: "ok" | "fail";
  error?: string;
}

/**
 * A deployment-scoped rich-markdown annotation (Buildkite semantics:
 * upsert by `context`). Distinct from per-resource {@link AnnotateEvent}
 * notes — `id`/`fqn` are optional and only set for resource-scoped
 * annotations.
 */
export interface AnnotationEvent extends ApplyEventBase {
  kind: "annotation";
  id?: string;
  /** Upsert key: emitting the same context again replaces the annotation. */
  context: string;
  style: "success" | "info" | "warning" | "error";
  markdown: string;
}

type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

/** An {@link ApplyEvent} before the engine stamps `ts` at emission. */
export type UnstampedApplyEvent = DistributiveOmit<ApplyEvent, "ts">;

/**
 * Stamp `ts` (epoch millis, via the Effect `Clock`) onto an event at
 * emission time. Every engine emit site routes through this so event
 * timestamps reflect when things happened, not when a renderer received
 * them.
 */
export const stampApplyEvent = (
  event: UnstampedApplyEvent,
): Effect.Effect<ApplyEvent> =>
  Effect.map(Clock.currentTimeMillis, (ts) => ({ ...event, ts }) as ApplyEvent);
