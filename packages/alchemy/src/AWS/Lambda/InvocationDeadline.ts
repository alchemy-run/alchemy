import type * as lambda from "aws-lambda";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { Flusher } from "effect/unstable/observability/OtlpExporter";

/**
 * The AWS Lambda invocation context — the `context` argument Lambda passes
 * to the handler. Provided to every invocation's effect by the Lambda
 * dispatcher (see `Function.ts`).
 */
export class HandlerContext extends Context.Service<
  HandlerContext,
  lambda.Context
>()("AWS.Lambda.HandlerContext") {}

/**
 * Environment variable the deploy side writes from
 * {@link FunctionCommonProps.timeoutMargin} and the runtime reads per
 * invocation. Whole milliseconds; `0` disables the deadline flush.
 */
export const TIMEOUT_MARGIN_ENV = "ALCHEMY_LAMBDA_TIMEOUT_MARGIN_MS";

/**
 * Default deadline margin. Wide enough for one OTLP export round-trip to a
 * remote collector (dd-trace uses 100 ms, but it flushes to a local
 * extension over localhost).
 */
export const DEFAULT_TIMEOUT_MARGIN_MS = 500;

/**
 * Span attribute set on a root span the deadline flush ended early. Lets a
 * backend tell "flushed because the invocation was about to time out" from
 * a handler-reported failure — and, when the handler does finish inside the
 * margin and re-ends the span successfully, explains the earlier export.
 */
export const TIMEOUT_IMMINENT_ATTRIBUTE = "aws.lambda.timeout.imminent";

/**
 * Recorded on the invocation's root span when the deadline flush fires:
 * the handler was still running `marginMs` before the function's timeout.
 *
 * This is never thrown and never fails the invocation. The handler keeps
 * running; the error is the span's exit status so the trace of an
 * invocation Lambda is about to freeze exports as an errored span instead
 * of vanishing. If the handler does finish inside the margin, its own
 * completion ends the span again with the real outcome (see
 * {@link withInvocationDeadline}).
 */
export class InvocationTimeoutError extends Data.TaggedError(
  "AWS.Lambda.InvocationTimeoutError",
)<{
  readonly functionName: string;
  readonly requestId: string;
  /** Milliseconds the handler had been running when the flush fired. */
  readonly budgetMs: number;
  /** Milliseconds reserved before Lambda's hard timeout. */
  readonly marginMs: number;
}> {
  override get message() {
    return `Lambda invocation ${this.requestId} of ${this.functionName} was still running after ${this.budgetMs}ms, ${this.marginMs}ms before its timeout; telemetry was flushed early in case Lambda freezes the sandbox`;
  }
}

interface Deadline {
  /** Tell the enclosing guard an inner guard now owns the deadline. */
  readonly claim: () => void;
}

/**
 * Internal handshake between nested deadline guards. The dispatcher guards
 * every listener; the HTTP listener guards again *inside* its `http.server`
 * span so the flush can end that span. The inner guard claims the deadline
 * and the outer one stands down, so the flush runs exactly once, from the
 * innermost guard.
 */
class InvocationDeadline extends Context.Service<
  InvocationDeadline,
  Deadline
>()("AWS.Lambda.InvocationDeadline") {}

/**
 * Parse the runtime margin from its environment variable. Unset → default;
 * unparseable/negative → default; `0` → flush disabled.
 */
export const readTimeoutMargin = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MARGIN_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0
    ? Math.floor(ms)
    : DEFAULT_TIMEOUT_MARGIN_MS;
};

/**
 * Normalize a {@link FunctionCommonProps.timeoutMargin} to whole
 * milliseconds for the env var. Handles the state-JSON `Duration` shape the
 * same way `toTimeoutSeconds` does. Infinite → `undefined` (default).
 */
export const toTimeoutMarginMillis = (
  margin: Duration.Duration | undefined,
): number | undefined => {
  if (margin === undefined) return undefined;
  const json = margin as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  const input: Duration.Input =
    json._id === "Duration"
      ? json._tag === "Millis"
        ? json.millis!
        : json._tag === "Nanos"
          ? BigInt(json.nanos!)
          : "Infinity"
      : margin;
  const millis = Duration.toMillis(input);
  return Number.isFinite(millis) ? Math.max(0, Math.ceil(millis)) : undefined;
};

/**
 * Flush telemetry for an invocation that is still running `margin` before
 * Lambda's hard timeout — without touching the handler.
 *
 * A Lambda that hits its timeout is frozen mid-flight: the telemetry
 * exporter's buffer and the still-open root span die with it — precisely
 * the invocation you most want a trace for. The deadline is known up front
 * (`context.getRemainingTimeInMillis()`), and a sandbox only ever handles
 * one invocation at a time, so a pre-deadline timer is race-free. It parks
 * for `remaining - margin` and, if the handler is still running by then:
 *
 * 1. ends the current span (the `http.server` root span on the HTTP path)
 *    with {@link InvocationTimeoutError} and marks it
 *    {@link TIMEOUT_IMMINENT_ATTRIBUTE};
 * 2. logs a warning through the invocation's logger, so the log record
 *    carries the trace id;
 * 3. drains every exporter through the OTLP {@link Flusher}.
 *
 * The handler is never interrupted and the invocation's outcome is never
 * changed. If Lambda freezes the sandbox, the trace already exists. If the
 * handler finishes inside the margin, its response goes out as normal and
 * the tracer ends the span a second time with the real exit — the earlier,
 * marked export is the accepted false positive. Spans still open at the
 * flush (other than the root) are not exported; anything already ended,
 * and every log record, is.
 *
 * The margin comes from `ALCHEMY_LAMBDA_TIMEOUT_MARGIN_MS`
 * ({@link FunctionCommonProps.timeoutMargin} on the deploy side; default
 * {@link DEFAULT_TIMEOUT_MARGIN_MS}); `0` disables it. Without a
 * `HandlerContext` (unit tests, non-Lambda hosts) the effect runs
 * unguarded.
 *
 * Guards nest: an inner guard (the HTTP listener's, placed inside the
 * `http.server` span so the flush can end it) takes the deadline over from
 * the outer one (the dispatcher's), so the flush runs once, from the
 * innermost guard, closest to the work.
 */
export const withInvocationDeadline = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const context = Option.getOrUndefined(
      yield* Effect.serviceOption(HandlerContext),
    );
    if (
      context === undefined ||
      typeof context.getRemainingTimeInMillis !== "function"
    ) {
      return yield* self;
    }
    const marginMs = readTimeoutMargin(process.env[TIMEOUT_MARGIN_ENV]);
    if (marginMs <= 0) {
      return yield* self;
    }
    const remainingMs = context.getRemainingTimeInMillis();
    const budgetMs = remainingMs - marginMs;
    if (!(budgetMs > 0)) {
      // A margin at or above the function's timeout would flush at t=0 on
      // every invocation. Run unguarded and say why.
      yield* Effect.logWarning(
        `${TIMEOUT_MARGIN_ENV}=${marginMs} leaves no invocation budget (${remainingMs}ms remaining); the invocation deadline flush is disabled`,
      );
      return yield* self;
    }

    // Take the deadline over from any enclosing guard.
    const outer = yield* Effect.serviceOption(InvocationDeadline);
    if (Option.isSome(outer)) {
      outer.value.claim();
    }
    let claimed = false;
    const deadline: Deadline = {
      claim: () => {
        claimed = true;
      },
    };

    const flushBeforeDeadline = Effect.gen(function* () {
      const error = new InvocationTimeoutError({
        functionName: context.functionName,
        requestId: context.awsRequestId,
        budgetMs,
        marginMs,
      });
      // The root span is still open (that is why we are here); end it so
      // it exports with the timeout as its status. Only `Span`s can be
      // ended — an external parent (a propagated `traceparent` with no
      // local span) is skipped.
      const span = yield* Effect.option(Effect.currentSpan);
      if (Option.isSome(span) && span.value.status._tag === "Started") {
        span.value.attribute(TIMEOUT_IMMINENT_ATTRIBUTE, true);
        span.value.end(yield* Clock.currentTimeNanos, Exit.fail(error));
      }
      yield* Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({
          requestId: error.requestId,
          budgetMs: error.budgetMs,
          marginMs: error.marginMs,
        }),
      );
      const flusher = yield* Effect.serviceOption(Flusher);
      if (Option.isSome(flusher)) {
        yield* flusher.value.flush;
      }
    });

    // The watcher inherits this fiber's context — the invocation's logger,
    // exporters and (on the HTTP path) the root span — and is interrupted
    // when the handler settles. The flush itself is uninterruptible so a
    // handler finishing mid-flush waits for the export rather than
    // abandoning an in-flight batch.
    const watcher = yield* Effect.forkChild(
      Effect.sleep(Duration.millis(budgetMs)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            claimed ? Effect.void : Effect.uninterruptible(flushBeforeDeadline),
          ),
        ),
      ),
    );
    return yield* self.pipe(
      Effect.provideService(InvocationDeadline, deadline),
      Effect.ensuring(Fiber.interrupt(watcher)),
    );
  });
