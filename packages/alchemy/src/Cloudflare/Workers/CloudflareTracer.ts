/**
 * Effect Tracer that mirrors `Effect.withSpan` / `Effect.fn` spans into
 * Cloudflare Workers Observability via `tracing.startActiveSpan`.
 *
 * Built once per event (see {@link Telemetry} + `buildEventTelemetry`).
 * Captures the invocation's async context; do not cache the built Tracer
 * across requests. Not exported from the Cloudflare barrel.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";
import cloudflare_workers from "./cloudflare_workers.ts";

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];
type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

interface CloudflareSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  end(): void;
}

interface CloudflareTracing {
  startActiveSpan<T>(name: string, callback: (span: CloudflareSpan) => T): T;
}

let warnedMissingApi = false;

class Span extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly runInContext: RunInContext,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    super({
      name: options.name,
      parent: options.parent,
      annotations: options.annotations,
      links: options.links,
      startTime: options.startTime,
      kind: options.kind,
      sampled: options.sampled && (cloudflareSpan?.isTraced ?? false),
    });
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    if (
      Predicate.isString(value) ||
      Predicate.isNumber(value) ||
      Predicate.isBoolean(value)
    ) {
      this.cloudflareSpan?.setAttribute(key, value);
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;
    super.end(endTime, exit);
    this.cloudflareSpan?.setAttribute(
      "effect.exit",
      Exit.isSuccess(exit)
        ? "success"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    );
    this.cloudflareSpan?.end();
  }
}

const tracingOf = (
  workers: typeof import("cloudflare:workers"),
): CloudflareTracing | undefined =>
  (workers as { tracing?: CloudflareTracing }).tracing;

/**
 * Per-event Tracer Layer. Cloudflare owns sampling and export; scalar
 * attributes are forwarded; events, links, and non-scalars stay
 * Effect-local. Completion is recorded as `effect.exit`. Effect trace/span
 * IDs are independent of Cloudflare's opaque IDs.
 */
export const layer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const workers = yield* cloudflare_workers;
    const tracing = tracingOf(workers);
    if (tracing?.startActiveSpan === undefined && !warnedMissingApi) {
      warnedMissingApi = true;
      yield* Effect.logWarning(
        "Cloudflare.Telemetry() requires compatibility date >= 2026-07-28 " +
          "(tracing.startActiveSpan). Effect spans will not appear in " +
          "Workers Observability.",
      );
    }
    const invocationContext = AsyncLocalStorage.snapshot();
    const contextFor = (span: Tracer.AnySpan | undefined): RunInContext => {
      while (span?._tag === "Span") {
        if (span instanceof Span) return span.runInContext;
        span = Option.getOrUndefined(span.parent);
      }
      return invocationContext;
    };

    return Tracer.make({
      span(options) {
        const parentContext = options.root
          ? invocationContext
          : contextFor(Option.getOrUndefined(options.parent));

        if (!options.sampled || tracing?.startActiveSpan === undefined) {
          return new Span(options, parentContext);
        }

        return parentContext(() =>
          tracing.startActiveSpan(
            options.name,
            (span) => new Span(options, AsyncLocalStorage.snapshot(), span),
          ),
        );
      },
      context(primitive, fiber) {
        return contextFor(fiber.currentSpan)(() =>
          primitive["~effect/Effect/evaluate"](fiber),
        );
      },
    });
  }),
);
