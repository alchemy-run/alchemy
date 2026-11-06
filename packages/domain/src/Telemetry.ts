import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

/**
 * How a hosted model records telemetry. Tuning, not meaning, so it lives on
 * the Layer: `Bank.layer(handlers, { telemetry: { views: false } })`.
 */
export interface Options {
  /**
   * Trace every view applying an event. Views apply every event they fold,
   * so this is the busiest span.
   * @default true
   */
  readonly views?: boolean;
}

/** @internal */
export interface Resolved {
  readonly views: boolean;
}

/** @internal */
export const resolve = (options: Options | undefined): Resolved => ({
  views: options?.views ?? true,
});

/** A span's identity, stored with what it caused so later work can continue or link to it. @internal */
export const TraceJson = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  sampled: Schema.Boolean,
});
export type TraceJson = typeof TraceJson.Type;

/** The current span, as JSON, if any. @internal */
export const currentTrace: Effect.Effect<TraceJson | undefined> = Effect.currentParentSpan.pipe(
  Effect.map((span): TraceJson => ({
    traceId: span.traceId,
    spanId: span.spanId,
    sampled: span.sampled,
  })),
  Effect.orElseSucceed(() => undefined),
);

/** A stored trace, as a parent or link target. @internal */
export const spanOf = (trace: TraceJson): Tracer.ExternalSpan =>
  Tracer.externalSpan({ traceId: trace.traceId, spanId: trace.spanId, sampled: trace.sampled });

/**
 * The flow work belongs to: the id of the first command in a chain of
 * commands, events and reactions. Policies and sagas provide it, so every
 * command they send carries it on.
 *
 * @internal
 */
export class Correlation extends Context.Service<Correlation, { readonly id: string }>()(
  "alchemy/Domain/Correlation",
) {}

/** The correlation id for a new command: the one it was caused by, else its own id. @internal */
export const correlationFor = (commandId: string): Effect.Effect<string> =>
  Effect.map(Effect.serviceOption(Correlation), (c) => (Option.isSome(c) ? c.value.id : commandId));

// ---------------------------------------------------------------- metrics

const ms = Metric.exponentialBoundaries({ start: 1, factor: 2, count: 22 });

/** Commands handled, by `domain.aggregate`, `domain.command` and `domain.outcome`. */
export const commands = Metric.counter("domain.commands", {
  description: "Commands handled by aggregates",
  incremental: true,
});
/** How long an aggregate took to decide and commit a command, in milliseconds. */
export const commandDuration = Metric.histogram("domain.command.duration", {
  description: "Milliseconds to decide and commit a command",
  boundaries: ms,
});
/** Events committed, by `domain.aggregate` and `domain.event`. */
export const events = Metric.counter("domain.events", {
  description: "Events committed by aggregates",
  incremental: true,
});
/** Milliseconds from an event's commit to a reaction handling it, by `domain.consumer`. */
export const lag = Metric.histogram("domain.lag", {
  description: "Milliseconds from commit to handling, per consumer",
  boundaries: ms,
});
/** Reaction runs, by `domain.kind`, `domain.consumer` and `domain.outcome`. */
export const runs = Metric.counter("domain.runs", {
  description: "Policy, view, projection and saga runs",
  incremental: true,
});
/** Inputs per projection batch. */
export const batchSize = Metric.histogram("domain.projection.batch_size", {
  description: "Inputs per projection batch",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 12 }),
});
/** Queries run, by `domain.query` and `domain.outcome`. */
export const queries = Metric.counter("domain.queries", {
  description: "Queries run",
  incremental: true,
});
/** External system calls, by `domain.system`, `domain.operation` and `domain.outcome`. */
export const externalCalls = Metric.counter("domain.external.calls", {
  description: "Calls to external systems",
  incremental: true,
});

/** @internal */
export const record = <M extends Metric.Metric<number, any>>(
  metric: M,
  attributes: Record<string, string>,
  value = 1,
) => Metric.update(Metric.withAttributes(metric, attributes), value);

/** The outcome of an exit, for metrics and spans: ok, the failure's tag, or defect. @internal */
export const outcomeOf = (failure: unknown): string =>
  failure === undefined
    ? "ok"
    : typeof failure === "object" && failure !== null && "_tag" in failure
      ? String((failure as { readonly _tag: unknown })._tag)
      : "defect";
