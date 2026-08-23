import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Telemetry from "@/Telemetry.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Durable Object HTTP target whose event emits a child span. */
export class OtelEventFlushTarget extends Cloudflare.DurableObject<OtelEventFlushTarget>()(
  "OtelEventFlushTarget",
  Effect.succeed(
    Effect.succeed({
      fetch: Effect.succeed(HttpServerResponse.text("durable-object-ok")).pipe(
        Effect.withSpan("otel-event-flush.child"),
      ),
    }),
  ),
) {}

/** Worker that emits one Worker and one Durable Object OTLP event batch. */
export default class OtelEventFlushWorker extends Cloudflare.Worker<OtelEventFlushWorker>()(
  "OtelEventFlushWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const targetNamespace = yield* OtelEventFlushTarget;

    return {
      fetch: Effect.gen(function* () {
        const targetClient = Cloudflare.toHttpClient(
          targetNamespace.getByName("target"),
        );
        const response = yield* targetClient.execute(
          HttpClientRequest.get("http://otel-event-flush-target/"),
        );
        return HttpServerResponse.text(`worker-saw:${yield* response.text}`);
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Config.string("OTLP_EVENT_FLUSH_URL").pipe(
          Effect.map((url) =>
            Telemetry.layerOtlp({
              traces: { url },
              serviceName: "otel-event-flush-test",
            }),
          ),
        ),
      ),
    ),
  ),
) {}
