import { Webhooks } from "@distilled.cloud/stripe";
import { GetCoreEvent } from "@distilled.cloud/stripe/stripe";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isRedactedMarker, RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  EventSource,
  thinWebhookPath,
  webhookPath,
  webhookSecretEnvName,
  type ConsumeEventsProps,
  type EventSourceService,
} from "./ConsumeEvents.ts";
import { EventDestination } from "./EventDestination.ts";
import {
  isThinEventClass,
  type StripeEventClass,
  type StripeEventInstance,
  type ThinEventObject,
} from "./Events.ts";
import { attachStripeToken, authorizeWith } from "./StripeHttp.ts";
import { WebhookEndpoint } from "./WebhookEndpoint.ts";

/** A host that accepts environment bindings, such as a Cloudflare Worker. */
export interface EnvBindingHost {
  readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
}

/**
 * Attach a webhook signing secret to a host's environment, under the key
 * {@link consumeEvents} reads for `path`.
 *
 * {@link consumeEvents} binds the secret itself for the endpoint it
 * provisions. Declare a {@link WebhookEndpoint} manually only when you need
 * a URL you already own; then bind the minted secret yourself.
 */
export const bindWebhookSecret = (
  host: EnvBindingHost,
  secret: WebhookEndpoint["secret"],
  path?: string,
): Effect.Effect<void> =>
  host.bind(`stripe-webhook:${webhookPath(path)}`, {
    env: {
      [webhookSecretEnvName(path)]: secret,
    },
  });

/**
 * {@link consumeEvents} on any {@link WebhookHost}.
 *
 * Deploy-time: provisions a {@link WebhookEndpoint} pointing at the host (at
 * the subscribed path) and binds its minted signing secret so deliveries can
 * be verified. Under `alchemy dev` the host is not publicly
 * reachable, so no endpoint is provisioned. Runtime: claims requests on that
 * path, verifies `Stripe-Signature`, and runs the handler once per event.
 *
 * Every Cloudflare Worker is a {@link WebhookHost}, so this is the only layer
 * to provide.
 *
 * @layer
 * @product Webhook
 * @provides Stripe.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps,
      process: (event: StripeEventInstance) => Effect.Effect<void, never, never>,
    ) {
      // Signing secrets are bound through the host's RuntimeContext, which
      // every host provides its init, like `GitHub.RepositoryEventSourceLive`.
      const runtime = yield* RuntimeContext;
      const snapshotEvents = props.events.filter((event) => !isThinEventClass(event));
      const thinEvents = props.events.filter(isThinEventClass);

      // Stripe only delivers to public URLs, and under `alchemy dev` the
      // host is on localhost: skip the endpoints rather than fail the whole
      // stack. Deliveries then answer 500 (no signing secret).
      const provision = (path: string, create: Effect.Effect<void, never, any>) =>
        globalThis.__ALCHEMY_RUNTIME__
          ? Effect.void
          : Namespace.push(
              host.LogicalId,
              Effect.gen(function* () {
                const context = yield* Effect.serviceOption(AlchemyContext);
                if (Option.isSome(context) && context.value.dev) {
                  yield* Effect.logWarning(
                    `Stripe.consumeEvents: no webhook for ${path} under alchemy dev; Stripe only delivers to public URLs, so deploy to receive events.`,
                  );
                  return;
                }
                yield* create;
              }),
            );

      if (snapshotEvents.length > 0) {
        const path = webhookPath(props.path);
        yield* provision(
          path,
          Effect.gen(function* () {
            const endpoint = yield* WebhookEndpoint(id, {
              url: Output.interpolate`${host.url}${path}`,
              enabledEvents: [...snapshotEvents],
            });
            // A binding, not a prop: the endpoint depends on the host's URL.
            yield* bindWebhookSecret(host, endpoint.secret, path);
          }),
        );
        const secret = runtime.get<unknown>(webhookSecretEnvName(path));
        const byType = new Map(snapshotEvents.map((event) => [event.type, event] as const));
        yield* host.route(path, (request) =>
          handleDelivery(request, secret, (parsed) =>
            Effect.gen(function* () {
              const Ctor = byType.get(parsed.type ?? "");
              if (Ctor === undefined) return;
              const data =
                typeof parsed.data === "object" && parsed.data !== null && "object" in parsed.data
                  ? (parsed.data as { object: unknown }).object
                  : parsed.data;
              yield* process(new Ctor(data as never));
            }),
          ),
        );
      }

      if (thinEvents.length > 0) {
        const path = thinWebhookPath(props.path);
        // A thin delivery only carries the event id: the handler fetches the
        // event, so the host needs a key that can read events.
        const token = yield* attachStripeToken(undefined, ["events_read"], "Stripe.ConsumeEvents");
        const authorize = authorizeWith(token);
        yield* provision(
          path,
          Effect.gen(function* () {
            const destination = yield* EventDestination(`${id}Thin`, {
              eventPayload: "thin",
              enabledEvents: thinEvents.map((event) => event.type),
              webhookEndpoint: { url: Output.interpolate`${host.url}${path}` },
            });
            yield* bindWebhookSecret(host, destination.signingSecret, path);
          }),
        );
        const secret = runtime.get<unknown>(webhookSecretEnvName(path));
        const byType = new Map(thinEvents.map((event) => [event.type, event] as const));
        yield* host.route(path, (request) =>
          handleDelivery(request, secret, (notification) =>
            Effect.gen(function* () {
              const Ctor = byType.get(notification.type ?? "");
              if (Ctor === undefined || typeof notification.id !== "string") return;
              const event = yield* authorize(GetCoreEvent({ id: notification.id }));
              const object = yield* decodeThinEvent(event);
              yield* process(new Ctor(object));
            }).pipe(Effect.orDie),
          ),
        );
      }
    }) as EventSourceService;
  }),
);

const ThinEventSchema = Schema.Struct({
  id: Schema.String,
  created: Schema.String,
  livemode: Schema.Boolean,
  related_object: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: Schema.String, type: Schema.String, url: Schema.String })),
  ),
  data: Schema.optional(Schema.Unknown),
  context: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeThinEvent = (event: unknown): Effect.Effect<ThinEventObject, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ThinEventSchema)(event).pipe(
    Effect.map((decoded) => ({
      id: decoded.id,
      created: decoded.created,
      livemode: decoded.livemode,
      relatedObject: decoded.related_object ?? undefined,
      data: decoded.data,
      context: decoded.context ?? undefined,
    })),
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
  request: Request,
  secret: Effect.Effect<unknown>,
  dispatch: (event: Webhooks.StripeEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const payload = yield* Effect.promise(() => request.text());
    const signature = request.headers.get("stripe-signature") ?? "";
    const resolved = asWebhookSecret(yield* secret);
    if (resolved === undefined) {
      return new Response("webhook secret missing", { status: 500 });
    }
    const parsed = yield* Webhooks.constructEvent({
      payload,
      signature,
      secret: Redacted.value(resolved),
    }).pipe(
      Effect.catchTag(
        ["StripeWebhookSignatureError", "StripeWebhookPayloadParseError"],
        () => Effect.undefined,
      ),
    );
    if (parsed === undefined) {
      return new Response("invalid signature", { status: 401 });
    }
    yield* dispatch(parsed);
    return new Response(null, { status: 200 });
  });
