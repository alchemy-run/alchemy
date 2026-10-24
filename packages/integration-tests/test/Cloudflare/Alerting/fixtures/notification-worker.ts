import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// Declares no mechanisms: the Worker's event source adds its webhook.
export const IssuePolicy = Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
  alertType: "workers_observability_real_time_issue",
});

export const Received = Cloudflare.KV.Namespace("ReceivedNotifications");

// Consumes the notifications of the policy an Issues automation scoped to this
// Worker notifies, so `/boom` makes Cloudflare notify the Worker about itself.
export default class NotificationWorker extends Cloudflare.Worker<NotificationWorker>()(
  "NotificationWorker",
  {
    main: import.meta.url,
    observability: { enabled: true, issues: { enabled: true } },
  },
  Effect.gen(function* () {
    const policy = yield* IssuePolicy;
    const received = yield* Cloudflare.KV.ReadWriteNamespace(yield* Received);

    yield* Cloudflare.Alerting.consumeNotifications(policy, (notification) =>
      received
        .put(
          `notification:${notification.alertCorrelationId ?? notification.ts}`,
          JSON.stringify(notification),
        )
        .pipe(Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/boom") {
          return yield* Effect.die(new Error("alchemy notification event source test"));
        }
        if (url.pathname === "/received") {
          const { keys } = yield* received.list({ prefix: "notification:" }).pipe(Effect.orDie);
          const values = yield* Effect.forEach(keys, (key) =>
            received.get(key.name).pipe(Effect.orDie),
          );
          return yield* HttpServerResponse.json({
            notifications: values.flatMap((value) => (value ? [JSON.parse(value)] : [])),
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Alerting.NotificationEventSourceLive,
        Cloudflare.KV.ReadWriteNamespaceBinding,
      ),
    ),
  ),
) {}
