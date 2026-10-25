import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./repo.ts";

export const ISSUE_TITLE = "Payment failures spiking";

// Alerts on its own logs: three declined payments within five minutes open a
// GitHub issue.
export default class CheckoutWorker extends Cloudflare.Worker<CheckoutWorker>()(
  "CheckoutWorker",
  {
    main: import.meta.url,
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  },
  Effect.gen(function* () {
    const self = yield* Cloudflare.Worker;
    const createIssue = yield* GitHub.CreateIssue(yield* Repo);

    const paymentFailures = yield* Cloudflare.Alerting.CustomAlert("PaymentFailures", {
      query: Output.interpolate`SELECT count() AS value FROM logs.workersLogs
        WHERE accountTag = '${self.accountId}'
          AND scriptName = '${self.workerName}'
          AND level = 'error'
          AND message LIKE '%payment declined%'`,
      trigger: { type: "threshold", operator: ">=", value: 3, window: "5m" },
      every: "1m",
    });

    // Cloudflare notifies when the alert starts and again when it resolves.
    yield* Cloudflare.Alerting.consumeNotifications(paymentFailures, (notification) =>
      notification.alertEvent === "ALERT_STATE_EVENT_START"
        ? createIssue({ title: ISSUE_TITLE, body: notification.text }).pipe(Effect.orDie)
        : Effect.void,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (new URL(request.url, "http://x").pathname === "/charge") {
          yield* Effect.logError("payment declined: card_declined");
          return HttpServerResponse.text("payment declined", { status: 402 });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Alerting.NotificationEventSourceLive, GitHub.CreateIssueHttp),
    ),
  ),
) {}
