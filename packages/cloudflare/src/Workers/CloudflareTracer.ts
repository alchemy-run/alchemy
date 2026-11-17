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
type CloudflareSpan = ReturnType<(typeof import("cloudflare:workers"))["tracing"]["startSpan"]>;

/** An async context snapshot and the Cloudflare span active inside it. */
interface AsyncContext {
  readonly run: RunInContext;
  readonly activeSpanId: string | undefined;
}

class Span extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly asyncContext: AsyncContext,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    // Cascade Cloudflare's decision: an untraced invocation (`isTraced`
    // false — e.g. traces disabled; head sampling is applied later, at
    // ingestion) or a runtime without the API marks the Effect span
    // unsampled, so descendants skip `startActiveSpan` entirely.
    super({
      ...options,
      sampled: options.sampled && (cloudflareSpan?.isTraced ?? false),
    });
  }

  override attribute(key: string, value: unknown): void {
    super.attribute(key, value);
    if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      this.cloudflareSpan?.setAttribute(key, value);
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    const outcome = Exit.isSuccess(exit)
      ? "success"
      : Cause.hasInterruptsOnly(exit.cause)
        ? "interrupted"
        : "failure";
    this.cloudflareSpan?.setAttribute("effect.exit", outcome);
    // Only a failure (or defect) is an error. Success and pure interruption
    // stay `unset`: `ok` is final in Cloudflare, so the tracer never claims
    // it, and a cancellation is not an application error.
    if (Exit.isFailure(exit) && outcome === "failure") {
      this.cloudflareSpan?.setStatus({
        code: "error",
        message: Cause.prettyErrors(exit.cause)[0]?.message,
      });
    }
    this.cloudflareSpan?.end();
  }
}

/**
 * Per-event Tracer Layer. Cloudflare owns sampling and export; scalar
 * attributes are forwarded; events, links, and non-scalars stay
 * Effect-local. Completion is recorded as `effect.exit`, and a failure also
 * sets the span status to `error`. Effect trace/span IDs are independent
 * of Cloudflare's opaque IDs.
 */
export const layer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    // `tracing` only exists on compatibility dates >= 2026-07-28. Deploy
    // already rejects older dates (`assertCloudflareTelemetryCompatibility`),
    // so a missing API here (an old local workerd) just keeps spans
    // Effect-local.
    const { tracing } = yield* cloudflare_workers;
    const activeSpanId = () => tracing?.getActiveSpan?.()?.spanContext().spanId;
    const capture = (): AsyncContext => ({
      run: AsyncLocalStorage.snapshot(),
      activeSpanId: activeSpanId(),
    });
    const invocationContext = capture();
    const contextFor = (span: Tracer.AnySpan | undefined): AsyncContext => {
      while (span?._tag === "Span") {
        if (span instanceof Span) return span.asyncContext;
        span = Option.getOrUndefined(span.parent);
      }
      return invocationContext;
    };
    // Switch to the snapshot only when a different Cloudflare span is
    // active: that is what nests platform spans under the Effect span.
    // Otherwise stay, so AsyncLocalStorage stores entered since the
    // snapshot (e.g. by middleware calling back into Effect) stay visible.
    const enter = <A>(context: AsyncContext, f: () => A): A =>
      activeSpanId() === context.activeSpanId ? f() : context.run(f);

    return Tracer.make({
      span(options) {
        const parentContext = options.root
          ? invocationContext
          : options.parent.pipe(Option.getOrUndefined, contextFor);

        if (!options.sampled || tracing?.startActiveSpan === undefined) {
          return new Span(options, parentContext);
        }

        return enter(parentContext, () =>
          tracing.startActiveSpan(options.name, (span) => new Span(options, capture(), span)),
        );
      },
      context(primitive, fiber) {
        return enter(contextFor(fiber.cache.span), () =>
          primitive["~effect/Effect/evaluate"](fiber),
        );
      },
    });
  }),
);
