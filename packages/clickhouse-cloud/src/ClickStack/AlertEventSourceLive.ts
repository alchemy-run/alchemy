import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Alert } from "./Alert.ts";
import {
  ALERT_SECRET_HEADER,
  AlertEventSource,
  type AlertEventSourceService,
  type AlertNotification,
  alertPath,
  alertSecretEnvName,
} from "./AlertEventSource.ts";
import { Webhook } from "./Webhook.ts";

/**
 * `ClickHouseCloud.ClickStack.consumeAlerts` on any {@link WebhookHost}.
 *
 * @layer
 * @product ClickStack
 * @provides ClickHouseCloud.ClickStack.AlertEventSource
 */
export const AlertEventSourceLive = Layer.effect(
  AlertEventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      alert: Alert,
      process: (notification: AlertNotification) => Effect.Effect<void, never, never>,
    ) {
      const path = alertPath(alert);
      const secret = (yield* Namespace.push(
        host.LogicalId,
        Random(`${alert.LogicalId}AlertSecret`),
      )).text;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const webhook = yield* createWebhook(`${alert.LogicalId}AlertWebhook`, {
              // From the props: the alert waits for this webhook (binding data).
              serviceId: alert.Props.serviceId,
              name: Output.interpolate`alchemy-${host.LogicalId}-${alert.LogicalId}`,
              service: "generic",
              url: Output.interpolate`${host.url}${path}`.pipe(Output.map(Redacted.make)),
              headers: { [ALERT_SECRET_HEADER]: secret },
            });
            // A binding, not a prop: the webhook depends on the host's URL.
            yield* alert.bind(`${host.LogicalId}:${path}`, { webhookIds: [webhook.id] });
          }),
        );
      }

      const resolved = yield* Output.named(Output.asOutput(secret), alertSecretEnvName(alert));

      yield* host.route(path, (request) =>
        Effect.gen(function* () {
          if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
          const expected = yield* resolved;
          if (expected === undefined)
            return new Response("webhook secret missing", { status: 500 });
          const given = request.headers.get(ALERT_SECRET_HEADER) ?? "";
          if (!timingSafeEqual(given, Redacted.value(expected))) {
            return new Response("invalid secret", { status: 401 });
          }
          const body = yield* Effect.promise(() => request.text());
          const payload = yield* Effect.try({
            try: (): unknown => JSON.parse(body),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (typeof payload !== "object" || payload === null) {
            return new Response("invalid payload", { status: 400 });
          }
          yield* process(payload as AlertNotification);
          return new Response(null, { status: 200 });
        }),
      );
    }) as AlertEventSourceService;
  }),
);

/** Constant-time comparison, so a forged header can't learn the secret from timing. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};
