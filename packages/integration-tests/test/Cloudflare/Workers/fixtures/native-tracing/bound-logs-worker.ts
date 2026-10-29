import * as Cloudflare from "@alchemy.run/cloudflare";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Namespace from "alchemy/Namespace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * A binding layer that contributes `observability.logs` to its host Worker,
 * the way a Workers Logs export binding would — alongside the traces
 * `Cloudflare.Telemetry()` contributes.
 */
const BoundLogs = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* Worker;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* Namespace.push(
        host.LogicalId,
        host.bind("Test.BoundLogs", {
          observability: { logs: { enabled: true, persist: false, headSamplingRate: 0.5 } },
        }),
      );
    }
  }),
);

/** Live-test Worker: traces and logs both contributed by bindings, none by props. */
export default class BoundLogsWorker extends Cloudflare.Worker<BoundLogsWorker>()(
  "NativeTracingBoundLogs",
  {
    main: import.meta.url,
    compatibility: { date: "2026-08-25" },
  },
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("bound-logs-ok")),
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Telemetry(), BoundLogs))),
) {}
