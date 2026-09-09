import type * as cf from "@cloudflare/workers-types";
import { Webhooks } from "@distilled.cloud/stripe";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Worker, isWorkerEvent } from "../Cloudflare/Workers/Worker.ts";
import {
  isRedactedMarker,
  unpackEnvValue,
  type RuntimeContext,
} from "../RuntimeContext.ts";
import type { StripeEventClass, StripeEventInstance } from "./Events.ts";
import type { WebhookEndpoint } from "./WebhookEndpoint.ts";

export interface ConsumeEventsProps<
  E extends readonly StripeEventClass[] = readonly StripeEventClass[],
> {
  /**
   * Event classes to subscribe to. The handler `event` parameter is the
   * union of these classes.
   */
  events: E;
  /**
   * Path on the host Worker. Defaults to `/webhooks/stripe`.
   */
  path?: string;
}

export type SelectedStripeEvent<E extends readonly StripeEventClass[]> =
  InstanceType<E[number]>;

export const webhookPath = (path?: string): string =>
  path ?? "/webhooks/stripe";

export const webhookSecretEnvName = (path?: string): string =>
  `STRIPE_WEBHOOK_SECRET_${webhookPath(path).replaceAll(/[^a-zA-Z0-9]/g, "_")}`;

/**
 * Attach a webhook signing secret to a Worker as `secret_text`.
 *
 * Call this from the Stack after both the Worker and the
 * {@link WebhookEndpoint} exist. The Worker init must not depend on the
 * endpoint (that cycles on `worker.url`); this bind is the only edge
 * that carries the minted secret onto the host.
 */
export const bindWebhookSecret = (
  host: Worker,
  secret: WebhookEndpoint["secret"],
  path?: string,
): Effect.Effect<void> =>
  host.bind("stripe-webhook", {
    env: {
      [webhookSecretEnvName(path)]: secret,
    },
  });

/**
 * Subscribe to Stripe webhook events on the host Worker.
 *
 * `consumeEvents` only listens and verifies — it does not create the
 * {@link WebhookEndpoint}. Declare that resource in the Stack after the
 * Worker (it needs `worker.url`), then {@link bindWebhookSecret}.
 *
 * Provide {@link ConsumeEventsLive} on the Worker Effect.
 *
 * ### Handling events
 * **Example:** Customer created and invoice paid
 * ```typescript
 * yield* Stripe.consumeEvents("Events", {
 *   events: [Stripe.CustomerCreated, Stripe.InvoicePaid],
 * }, Effect.fn(function* (event) {
 *   // event: CustomerCreated | InvoicePaid
 *   yield* Effect.log(event.type);
 * }));
 * ```
 *
 * @binding
 */
export function consumeEvents<
  const E extends readonly StripeEventClass[],
  Req = never,
>(
  props: ConsumeEventsProps<E>,
  process: (
    event: SelectedStripeEvent<E>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents<
  const E extends readonly StripeEventClass[],
  Req = never,
>(
  id: string,
  props: ConsumeEventsProps<E>,
  process: (
    event: SelectedStripeEvent<E>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource>;
export function consumeEvents(
  idOrProps: string | ConsumeEventsProps,
  propsOrProcess:
    | ConsumeEventsProps
    | ((event: StripeEventInstance) => Effect.Effect<void, never, any>),
  maybeProcess?: (
    event: StripeEventInstance,
  ) => Effect.Effect<void, never, any>,
): Effect.Effect<void, never, EventSource> {
  const [props, process] =
    typeof idOrProps === "string"
      ? [
          propsOrProcess as ConsumeEventsProps,
          maybeProcess as (
            event: StripeEventInstance,
          ) => Effect.Effect<void, never, any>,
        ]
      : [
          idOrProps,
          propsOrProcess as (
            event: StripeEventInstance,
          ) => Effect.Effect<void, never, any>,
        ];
  return EventSource.use((source) => source(props, process));
}

export type EventSourceService = <
  E extends readonly StripeEventClass[],
  Req = never,
>(
  props: ConsumeEventsProps<E>,
  process: (event: SelectedStripeEvent<E>) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class EventSource extends Context.Service<
  EventSource,
  EventSourceService
>()("Stripe.EventSource") {}

/**
 * Cloudflare Worker implementation of {@link consumeEvents}.
 *
 * @layer
 * @provides Stripe.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const ctx = yield* Worker;

    return Effect.fn(function* (
      props: ConsumeEventsProps,
      process: (
        event: StripeEventInstance,
      ) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props.path);
      const secretKey = webhookSecretEnvName(path);
      const byType = new Map(
        props.events.map((event) => [event.type, event] as const),
      );

      yield* ctx.listen((event) => {
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
        return handleDelivery(request, env, secretKey, byType, process).pipe(
          Effect.catchCause(() =>
            Effect.succeed(new Response("invalid signature", { status: 401 })),
          ),
        );
      });
    }) as EventSourceService;
  }),
);

const asWebhookSecret = (
  raw: unknown,
): Redacted.Redacted<string> | undefined => {
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
    const payload = yield* Effect.promise(() =>
      (request as unknown as Request).text(),
    );
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
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (parsed === undefined) {
      return new Response("invalid signature", { status: 401 });
    }
    const Ctor = byType.get(parsed.type ?? "");
    if (Ctor === undefined) {
      return new Response(null, { status: 200 });
    }
    const data =
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      "object" in parsed.data
        ? (parsed.data as { object: unknown }).object
        : parsed.data;
    yield* process(new Ctor(data as never)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });
