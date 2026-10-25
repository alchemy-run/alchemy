import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./repo.ts";

export const ISSUE_TITLE = "Card declines spiking";

// One declined charge: an error log inside the `checkout.charge` span, annotated
// with the order and the decline reason. Each becomes a Workers Logs attribute.
const charge = (orderId: string) =>
  Effect.logError("payment declined").pipe(
    Effect.annotateLogs({ orderId, reason: "card_declined" }),
    Effect.withSpan("checkout.charge"),
  );

// Alerts on its own logs: three card declines within five minutes open a GitHub
// issue.
export default class CheckoutWorker extends Cloudflare.Worker<CheckoutWorker>()(
  "CheckoutWorker",
  {
    main: import.meta.url,
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  },
  Effect.gen(function* () {
    const self = yield* Cloudflare.Worker;
    const createIssue = yield* GitHub.CreateIssue(yield* Repo);

    const cardDeclines = yield* Cloudflare.Alerting.CustomAlert("CardDeclines", {
      query: Output.interpolate`SELECT count() AS value FROM logs.workersLogs
        WHERE accountTag = '${self.accountId}'
          AND scriptName = '${self.workerName}'
          AND attributes['spanName'] = 'checkout.charge'
          AND attributes['reason'] = 'card_declined'`,
      trigger: { type: "threshold", operator: ">=", value: 3, window: "5m" },
      every: "1m",
    });

    // Cloudflare notifies when the alert starts and again when it resolves.
    yield* Cloudflare.Alerting.consumeNotifications(cardDeclines, (notification) =>
      notification.alertEvent === "ALERT_STATE_EVENT_START"
        ? createIssue({ title: ISSUE_TITLE, body: notification.text }).pipe(Effect.orDie)
        : Effect.void,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/charge") {
          yield* charge(url.searchParams.get("order") ?? "unknown");
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
