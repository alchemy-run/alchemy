import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { WorkerProps } from "@/Cloudflare/Workers/Worker.ts";

/**
 * Shared init Effect for native-tracing fixtures. `Cloudflare.Telemetry()`
 * enables Workers Traces and installs the per-event Tracer. Optional
 * `COLLECTOR_URL` adds logs-only OTLP so composition tests can put the
 * Cloudflare Tracer last without dropping logs.
 */
export const tracedWorkerImpl = Effect.gen(function* () {
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://x");
      const id = url.pathname;

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
        const native = Cloudflare.Telemetry({
          headSamplingRate: 1,
          persist: true,
        });
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
