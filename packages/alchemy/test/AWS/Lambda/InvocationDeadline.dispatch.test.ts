import { createFunctionRuntimeContext } from "@/AWS/Lambda/Function.ts";
import {
  InvocationTimeoutError,
  TIMEOUT_IMMINENT_ATTRIBUTE,
  TIMEOUT_MARGIN_ENV,
} from "@/AWS/Lambda/InvocationDeadline.ts";
import type * as lambda from "aws-lambda";
import { afterEach, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Flusher } from "effect/unstable/observability/OtlpExporter";

/**
 * Drives the real Lambda dispatcher (`createFunctionRuntimeContext(...)
 * .exports.handler`) in-process with a fake invocation context, pinning the
 * end-to-end contract of the deadline flush:
 *
 * - a slow HTTP invocation is NOT interrupted: it completes on its own and
 *   its response is returned;
 * - `margin` before the deadline the `http.server` root span was ended with
 *   `InvocationTimeoutError` (a FAILURE, marked timeout-imminent) and the
 *   exporters were flushed, because the HTTP listener's guard sits inside
 *   the span and the dispatcher's outer guard stands down;
 * - the handler's completion re-ends the span with the real outcome;
 * - a fast invocation is untouched.
 */
describe("AWS.Lambda dispatcher invocation deadline", () => {
  afterEach(() => {
    delete process.env[TIMEOUT_MARGIN_ENV];
  });

  const functionUrlEvent = (path: string): lambda.LambdaFunctionURLEvent =>
    ({
      version: "2.0",
      routeKey: "$default",
      rawPath: path,
      rawQueryString: "",
      headers: { host: "example.lambda-url.us-east-1.on.aws" },
      requestContext: {
        accountId: "123456789012",
        apiId: "example",
        domainName: "example.lambda-url.us-east-1.on.aws",
        domainPrefix: "example",
        http: {
          method: "GET",
          path,
          protocol: "HTTP/1.1",
          sourceIp: "203.0.113.42",
          userAgent: "test",
        },
        requestId: "req-1",
        routeKey: "$default",
        stage: "$default",
        time: "01/Jan/2026:00:00:00 +0000",
        timeEpoch: 0,
      },
      isBase64Encoded: false,
    }) as lambda.LambdaFunctionURLEvent;

  const invocationContext = (remainingMs: number): lambda.Context => {
    const startedAt = Date.now();
    return {
      functionName: "dispatch-fn",
      awsRequestId: "req-1",
      getRemainingTimeInMillis: () =>
        Math.max(0, remainingMs - (Date.now() - startedAt)),
    } as unknown as lambda.Context;
  };

  interface SpanEnd {
    readonly name: string;
    readonly exit: Exit.Exit<unknown, unknown>;
    readonly at: number;
  }

  const setup = Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const ends: SpanEnd[] = [];
    const flushes: number[] = [];
    const startedAt = Date.now();
    const recordingTracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          ends.push({ name: span.name, exit, at: Date.now() - startedAt });
          end(endTime, exit);
        };
        spans.push(span);
        return span;
      },
    });
    const flusher = Flusher.of({
      flush: Effect.sync(() => {
        flushes.push(Date.now() - startedAt);
      }),
      register: () => Effect.void,
    });
    const finalized: string[] = [];

    const ctx = createFunctionRuntimeContext("DeadlineFunction");
    // What `Telemetry.layer` registers during Construction: composed into
    // every invocation's request scope by `buildEventTelemetry`.
    ctx.telemetry = Layer.mergeAll(
      Layer.succeed(Tracer.Tracer, recordingTracer),
      Layer.succeed(Flusher, flusher),
    );
    yield* ctx.serve<never>(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // The Function URL bridge hands the handler an absolute URL.
        const path = new URL(request.url, "http://x").pathname;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized.push(path);
          }),
        );
        if (path === "/slow") {
          yield* Effect.sleep("2500 millis");
        }
        return HttpServerResponse.text("ok");
      }),
    );
    const exports = yield* ctx.exports;
    // `exports` is untyped (`Record<string, any>`); pin the handler effect's
    // type so the setup effect stays `R = never`.
    const handler = yield* exports.handler as Effect.Effect<
      (
        event: unknown,
        context: lambda.Context,
      ) => Promise<lambda.LambdaFunctionURLResult>
    >;
    return { handler, spans, ends, flushes, finalized };
  });

  const statusOf = (result: lambda.LambdaFunctionURLResult) =>
    typeof result === "string" ? undefined : result.statusCode;

  it("flushes at the margin and still lets a slow invocation complete", async () => {
    // 2 s remaining, default 500 ms margin: the flush fires at ~1.5 s; the
    // handler needs 2.5 s and is left alone.
    const { handler, ends, flushes, finalized } =
      await Effect.runPromise(setup);
    const startedAt = Date.now();
    const result = await handler(
      functionUrlEvent("/slow"),
      invocationContext(2_000),
    );
    const elapsed = Date.now() - startedAt;

    // Not interrupted: the real response, after the handler's own 2.5 s.
    expect(statusOf(result)).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(2_400);
    expect(finalized).toEqual(["/slow"]);

    // One flush, at the margin, before the handler was done.
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toBeGreaterThanOrEqual(1_400);
    expect(flushes[0]).toBeLessThan(2_400);

    // The http.server root span was ended twice: first by the flush with the
    // timeout as a real FAILURE, then by the tracer with the real outcome.
    const rootEnds = ends.filter((e) => e.name.startsWith("http.server"));
    expect(rootEnds).toHaveLength(2);
    const [early, final] = rootEnds;
    expect(Exit.isFailure(early.exit)).toBe(true);
    if (Exit.isFailure(early.exit)) {
      const failure = early.exit.cause.reasons.find((r) => r._tag === "Fail");
      expect(
        failure?._tag === "Fail" ? failure.error : undefined,
      ).toBeInstanceOf(InvocationTimeoutError);
    }
    expect(early.at).toBeLessThan(flushes[0] + 50);
    expect(Exit.isSuccess(final.exit)).toBe(true);
    expect(final.at).toBeGreaterThanOrEqual(2_400);
  });

  it("marks the early-ended span timeout-imminent", async () => {
    const { handler, spans } = await Effect.runPromise(setup);
    await handler(functionUrlEvent("/slow"), invocationContext(2_000));
    const root = spans.find((span) => span.name.startsWith("http.server"));
    expect(root?.attributes.get(TIMEOUT_IMMINENT_ATTRIBUTE)).toBe(true);
    expect(root?.attributes.get("http.response.status_code")).toBe(200);
  });

  it("leaves a fast invocation untouched", async () => {
    const { handler, spans, ends, flushes, finalized } =
      await Effect.runPromise(setup);
    const result = await handler(
      functionUrlEvent("/fast"),
      invocationContext(2_000),
    );
    expect(statusOf(result)).toBe(200);
    expect(finalized).toEqual(["/fast"]);
    expect(flushes).toHaveLength(0);
    expect(ends.filter((e) => e.name.startsWith("http.server"))).toHaveLength(
      1,
    );
    const root = spans.find((span) => span.name.startsWith("http.server"));
    expect(root?.attributes.has(TIMEOUT_IMMINENT_ATTRIBUTE)).toBe(false);
  });

  it("a margin of 0 never flushes early", async () => {
    process.env[TIMEOUT_MARGIN_ENV] = "0";
    const { handler, ends, flushes } = await Effect.runPromise(setup);
    const result = await handler(
      functionUrlEvent("/slow"),
      invocationContext(1_000),
    );
    expect(statusOf(result)).toBe(200);
    expect(flushes).toHaveLength(0);
    expect(ends.filter((e) => e.name.startsWith("http.server"))).toHaveLength(
      1,
    );
  });
});
