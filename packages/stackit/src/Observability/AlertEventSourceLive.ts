import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  AlertEventSource,
  alertPath,
  alertSecretEnvName,
  alertWebhookId,
  type AlertEventSourceProps,
  type AlertEventSourceService,
  type AlertHandler,
  type AlertNotification,
} from "./AlertEventSource.ts";
import { AlertWebhook } from "./AlertWebhook.ts";
import type { Instance } from "./Instance.ts";

/**
 * {@link AlertEventSource} on any {@link WebhookHost}.
 *
 * Deploy-time: creates an {@link AlertWebhook} pointing at the host, at a per-instance
 * path with a token in the query string, because STACKIT's API has no way to sign a
 * request. The token (yours, or a generated one) is bound onto the host. Under
 * `alchemy dev` the host is on localhost, which STACKIT can't reach, so no webhook is
 * created.
 *
 * Runtime: claims requests on the path, rejects any without the token, and runs the
 * handler once per notification. A failed handler answers 500, so Alertmanager tries
 * again.
 *
 * @layer
 * @product STACKIT Observability
 * @provides Stackit.Observability.AlertEventSource
 */
export const AlertEventSourceLive = Layer.effect(
  AlertEventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;

    // Cast below: the service type erases `process`'s requirements, so every event source
    // implementation casts its client.
    return Effect.fn(function* <E = never, Req = never>(
      instance: Instance,
      props: AlertEventSourceProps,
      process: AlertHandler<E, Req>,
    ) {
      const path = alertPath(instance, props);

      const token =
        props.secret ??
        (yield* Namespace.push(host.LogicalId, Random(`${alertWebhookId(instance, props)}Token`)))
          .text;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Stackit.Observability.consumeAlerts: no webhook for ${path} under alchemy dev; STACKIT only delivers to public URLs, so deploy to receive alerts.`,
              );
              return;
            }
            // Not `Output.interpolate`, which would print the token as `<redacted>`.
            const url = Output.all(host.url, Output.asOutput(token)).pipe(
              Output.map(([base, value]) => {
                const text = Redacted.value(value as Redacted.Redacted<string>);
                return Redacted.make(`${base}${path}?token=${encodeURIComponent(text)}`);
              }),
            );
            yield* AlertWebhook(alertWebhookId(instance, props), {
              instanceId: instance.instanceId,
              projectId: instance.projectId,
              url,
              matchers: props.matchers,
              groupBy: props.groupBy,
              groupWait: props.groupWait,
              groupInterval: props.groupInterval,
              repeatInterval: props.repeatInterval,
              sendResolved: props.sendResolved,
            });
          }),
        );
      }

      // Registers the token on the host at deploy, reads it back at runtime.
      const secret = yield* Output.named(
        Output.asOutput(token),
        alertSecretEnvName(instance, props),
      );

      yield* host.route(path, (request) => handleDelivery(request, secret, process));
    }) as AlertEventSourceService;
  }),
);

const handleDelivery = <E, Req>(
  request: Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined>,
  process: AlertHandler<E, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const resolved = yield* secret;
    // An empty token would match a request without one.
    if (resolved === undefined || Redacted.value(resolved) === "") {
      return new Response("alert token missing", { status: 500 });
    }
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!timingSafeEqual(token, Redacted.value(resolved))) {
      return new Response("invalid token", { status: 401 });
    }

    const notification = yield* Effect.tryPromise({
      try: () => request.json() as Promise<AlertNotification>,
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (typeof notification !== "object" || notification === null) {
      return new Response("invalid payload", { status: 400 });
    }

    // Alertmanager retries a 5xx, so a failure gets another try.
    const processed = yield* Effect.result(process(notification));
    return new Response(null, { status: Result.isSuccess(processed) ? 200 : 500 });
  });

/**
 * Constant-time string comparison, so a forged token can't learn the real one byte by
 * byte from response timing.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};
