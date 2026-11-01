import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Metrics = Stackit.Observability.Instance("AlertEventSourceInstance", {});

/** Always firing, so the test doesn't have to make anything fail. */
export const AlwaysFiring = Metrics.pipe(
  Effect.flatMap((instance) =>
    Stackit.Observability.AlertGroup("AlwaysFiring", {
      instanceId: instance.instanceId,
      rules: [
        {
          alert: "AlchemyTestAlwaysFiring",
          expr: "vector(1)",
          labels: { severity: "alchemy-test" },
        },
      ],
    }),
  ),
);

/** Holds the last notification: a Worker's memory doesn't outlive its isolate. */
export const Received = Cloudflare.KV.Namespace("AlertEventSourceReceived", {});

export default class AlertsWorker extends Cloudflare.Worker<AlertsWorker>()(
  "StackitAlertsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const received = yield* Cloudflare.KV.ReadWriteNamespace(Received);

    yield* Stackit.Observability.consumeAlerts(
      Metrics,
      {
        matchers: ['severity="alchemy-test"'],
        groupBy: ["alertname"],
        groupWait: "10s",
        groupInterval: "1m",
      },
      (notification) =>
        received
          .put(
            "last",
            JSON.stringify({
              status: notification.status,
              alertname: notification.commonLabels.alertname,
            }),
          )
          .pipe(Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://x").pathname === "/last") {
          const last = yield* received.get("last").pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ last: last ?? null });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Observability.AlertEventSourceLive,
        Cloudflare.KV.ReadWriteNamespaceBinding,
      ),
    ),
  ),
) {}
