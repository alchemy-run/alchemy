import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { WorkerProps } from "@/Cloudflare/Workers/Worker.ts";

/** KV namespace read by `/fanout` so each fiber emits a platform span. */
export const Store = Cloudflare.KV.Namespace("NativeTracingStore");

/**
 * Shared init Effect for native-tracing fixtures. `Cloudflare.Telemetry()`
 * enables Workers Traces and installs the per-event Tracer. Optional
 * `COLLECTOR_URL` adds logs-only OTLP so composition tests can put the
 * Cloudflare Tracer last without dropping logs.
 */
export const tracedWorkerImpl = Effect.gen(function* () {
  const kv = yield* Cloudflare.KV.ReadNamespace(yield* Store);
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const id = url.pathname;

      if (url.pathname === "/fanout") {
        // Parent/sibling attribution under Effect's scheduler: two
        // concurrent fibers plus an explicit fork, each sleeping (so the
        // scheduler resumes them on fresh timer ticks, outside the async
        // context that opened `operation`), each doing a KV read (a
        // Cloudflare auto-instrumented span) and opening a nested span.
        const requestId = url.searchParams.get("id") ?? "none";
        const branch = (name: string) =>
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            yield* kv.get(`${name}:${requestId}`).pipe(Effect.orDie);
            yield* Effect.sleep("5 millis");
            yield* Effect.log(name).pipe(Effect.withSpan(`${name}.inner`));
          }).pipe(Effect.withSpan(name));
        yield* Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", requestId);
          const forked = yield* Effect.forkChild(branch("forked"));
          yield* Effect.all([branch("child.a"), branch("child.b")], {
            concurrency: "unbounded",
          });
          yield* Fiber.join(forked);
        }).pipe(Effect.withSpan("operation"));
        return yield* HttpServerResponse.json({
          marker: "native-did-fanout",
          id: requestId,
        });
      }

      if (
        url.pathname === "/work" ||
        url.pathname === "/one" ||
        url.pathname === "/two"
      ) {
        const work = Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("request.id", id);
          yield* Effect.annotateCurrentSpan("scalar.number", 42);
          yield* Effect.annotateCurrentSpan("scalar.boolean", true);
          yield* Effect.annotateCurrentSpan("unsupported", { nested: true });
          yield* Effect.log("native-tracing-log").pipe(
            Effect.withSpan("native.child"),
          );
          return yield* HttpServerResponse.json({
            marker: "native-did-work",
            path: id,
          });
        }).pipe(Effect.withSpan("operation"));
        return yield* work;
      }
      return HttpServerResponse.text("native-tracing-ok");
    }).pipe(Effect.orDie),
  };
}).pipe(
  Effect.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const collectorUrl = yield* Config.string("COLLECTOR_URL").pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const composeOrder = yield* Config.string("COMPOSE_ORDER").pipe(
          Effect.orElseSucceed(() => "cf-last"),
        );
        const native = Layer.mergeAll(
          Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
          Cloudflare.KV.ReadNamespaceBinding,
        );
        if (collectorUrl === undefined) {
          return native;
        }
        const otlp = Telemetry.layerOtlp({
          logs: { url: `${collectorUrl.replace(/\/$/, "")}/v1/logs` },
          serviceName: "native-tracing-test",
        });
        // Both orders must keep OTLP logs after the Telemetry.layer
        // fromBoundConfig one-liner.
        return composeOrder === "otlp-last"
          ? Layer.mergeAll(native, otlp)
          : Layer.mergeAll(otlp, native);
      }),
    ),
  ),
);

/**
 * Construct an Effect-native traced Worker with extra test-site props
 * (streaming tails, experimental flags). `main` is this file.
 */
export const makeTracedWorker = (
  id: string,
  props: Partial<WorkerProps> = {},
) =>
  Cloudflare.Worker(
    id,
    {
      ...props,
      main: import.meta.url,
      compatibility: {
        date: props.compatibility?.date ?? "2026-08-25",
        flags: props.compatibility?.flags,
      },
    },
    tracedWorkerImpl,
  );

/**
 * Live-test Worker: traces enabled via the Layer, no Worker
 * `observability.traces` prop.
 */
export default class NativeTracingWorker extends Cloudflare.Worker<NativeTracingWorker>()(
  "NativeTracingWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-08-25" },
  },
  tracedWorkerImpl,
) {}
