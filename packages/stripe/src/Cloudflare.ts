import type * as cf from "@cloudflare/workers-types";
import { Webhooks } from "@distilled.cloud/stripe";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Worker, isWorkerEvent } from "alchemy/Cloudflare/Workers/Worker";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isRedactedMarker, unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  EventSource,
  webhookPath,
  webhookSecretEnvName,
  type ConsumeEventsProps,
  type EventSourceService,
} from "./ConsumeEvents.ts";
import type { StripeEventClass, StripeEventInstance } from "./Events.ts";
import { WebhookEndpoint } from "./WebhookEndpoint.ts";

/**
 * Attach a webhook signing secret to a Worker as `secret_text`.
 *
 * {@link consumeEvents} calls this automatically for the endpoint it
 * provisions. Declare a {@link WebhookEndpoint} manually only when you need
 * a URL you already own; then bind the minted secret yourself.
 */
export const bindWebhookSecret = (
  host: Worker,
  secret: WebhookEndpoint["secret"],
  path?: string,
): Effect.Effect<void> =>
  host.bind(`stripe-webhook:${webhookPath(path)}`, {
    env: {
      [webhookSecretEnvName(path)]: secret,
    },
  });

/**
 * Cloudflare Worker implementation of {@link consumeEvents}.
 *
 * Deploy-time: provisions a {@link WebhookEndpoint} pointing at this Worker
 * (at the subscribed path) and binds its minted signing secret onto the
 * Worker so deliveries can be verified. Under `alchemy dev` the Worker is
 * not publicly reachable, so no endpoint is provisioned. Runtime: registers a `fetch`
 * listener that claims requests on that path, verifies `Stripe-Signature`,
 * and runs the handler once per event.
 *
 * @layer
 * @product Webhook
 * @provides Stripe.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* Worker;

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps,
      process: (event: StripeEventInstance) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props.path);
      const secretKey = webhookSecretEnvName(path);
      const byType = new Map(props.events.map((event) => [event.type, event] as const));

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Stripe only delivers to public URLs, and under `alchemy dev` the
            // Worker is on localhost: skip the endpoint rather than fail the
            // whole stack. Deliveries then answer 500 (no signing secret).
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Stripe.consumeEvents: no webhook endpoint for ${path} under alchemy dev; Stripe only delivers to public URLs, so deploy to receive events.`,
              );
              return;
            }
            const endpoint = yield* WebhookEndpoint(id, {
              url: Output.interpolate`${host.url}${path}`,
              enabledEvents: [...props.events],
            });
            yield* bindWebhookSecret(host, endpoint.secret, props.path);
          }),
        );
      }

      yield* host.listen((event) => {
        if (!isWorkerEvent(event) || event.type !== "fetch") return;
        const request = event.input as cf.Request;
        let pathname: string;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          return;
        }
        if (pathname !== path) return;
        const env = (event.env ?? {}) as Record<string, unknown>;
        return handleDelivery(request, env, secretKey, byType, process);
      });
    }) as EventSourceService;
  }),
);

const asWebhookSecret = (raw: unknown): Redacted.Redacted<string> | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Redacted.isRedacted(raw)) {
    const value = Redacted.value(raw);
    return typeof value === "string" && value.length > 0
      ? (raw as Redacted.Redacted<string>)
      : undefined;
  }
  if (isRedactedMarker(raw) && typeof raw.value === "string") {
    return raw.value.length > 0 ? Redacted.make(raw.value) : undefined;
  }
  if (typeof raw === "string") return Redacted.make(raw);
  return undefined;
};

const handleDelivery = <Req>(
  request: cf.Request,
  env: Record<string, any>,
  secretKey: string,
  byType: Map<string, StripeEventClass>,
  process: (event: StripeEventInstance) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const payload = yield* Effect.promise(() => (request as unknown as Request).text());
    const signature = request.headers.get("stripe-signature") ?? "";
    const resolved = asWebhookSecret(
      unpackEnvValue(env[secretKey] as string | undefined) ?? env[secretKey],
    );
    if (resolved === undefined) {
      return new Response("webhook secret missing", { status: 500 });
    }
    const parsed = yield* Webhooks.constructEvent({
      payload,
      signature,
      secret: Redacted.value(resolved),
    }).pipe(
      Effect.catchTag(["StripeWebhookSignatureError", "StripeWebhookPayloadParseError"], () =>
        Effect.succeed(undefined),
      ),
    );
    if (parsed === undefined) {
      return new Response("invalid signature", { status: 401 });
    }
    const Ctor = byType.get(parsed.type ?? "");
    if (Ctor === undefined) {
      return new Response(null, { status: 200 });
    }
    const data =
      typeof parsed.data === "object" && parsed.data !== null && "object" in parsed.data
        ? (parsed.data as { object: unknown }).object
        : parsed.data;
    yield* process(new Ctor(data as never)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });
