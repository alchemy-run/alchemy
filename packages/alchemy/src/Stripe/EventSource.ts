import type * as cf from "@cloudflare/workers-types";
import { Webhooks } from "@distilled.cloud/stripe";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { RuntimeContext } from "../RuntimeContext.ts";
import * as Output from "../Output.ts";
import { isWorkerEvent, Worker } from "../Cloudflare/Workers/Worker.ts";
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

export const webhookSecretEnvName = (id: string): string =>
  `STRIPE_WEBHOOK_SECRET_${id.replaceAll(/[^a-zA-Z0-9]/g, "_")}`;

/**
 * Subscribe to Stripe webhook events on the host Worker.
 *
 * Declare a {@link WebhookEndpoint} in the Stack (after the Worker, using
 * `worker.url`). `consumeEvents` only listens and verifies — it does not
 * create the endpoint, so Worker init cannot deadlock on `url`.
 *
 * Provide {@link ConsumeEventsLive} on the Worker Effect.
 *
 * ### Handling events
 * **Example:** Customer created and invoice paid
 * ```typescript
 * yield* Stripe.consumeEvents(
 *   Events,
 *   {
 *     events: [Stripe.CustomerCreated, Stripe.InvoicePaid],
 *   },
 *   Effect.fn(function* (event) {
 *     // event: CustomerCreated | InvoicePaid
 *     yield* Effect.log(event.type);
 *   }),
 * );
 * ```
 *
 * @binding
 */
export function consumeEvents<
  const E extends readonly StripeEventClass[],
  Req = never,
>(
  endpoint: WebhookEndpoint,
  props: ConsumeEventsProps<E>,
  process: (
    event: SelectedStripeEvent<E>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource> {
  return EventSource.use((source) => source(endpoint, props, process));
}

export type EventSourceService = <
  E extends readonly StripeEventClass[],
  Req = never,
>(
  endpoint: WebhookEndpoint,
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
      endpoint: WebhookEndpoint,
      props: ConsumeEventsProps,
      process: (
        event: StripeEventInstance,
      ) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookPath(props.path);
      const byType = new Map(
        props.events.map((event) => [event.type, event] as const),
      );

      const secret = yield* Output.named(
        Output.asOutput(endpoint.secret),
        webhookSecretEnvName(endpoint.LogicalId),
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
        return handleDelivery(request, secret, byType, process);
      });
    }) as EventSourceService;
  }),
);

const handleDelivery = <Req>(
  request: cf.Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined>,
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
    const resolved = yield* secret;
    if (resolved === undefined) {
      return new Response("webhook secret missing", { status: 500 });
    }
    const parsed = yield* Webhooks.constructEvent({
      payload,
      signature,
      secret: resolved,
    }).pipe(
      Effect.catchTag(
        ["StripeWebhookSignatureError", "StripeWebhookPayloadParseError"],
        () => Effect.succeed(undefined),
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
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      "object" in parsed.data
        ? (parsed.data as { object: unknown }).object
        : parsed.data;
    yield* process(new Ctor(data as never)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });
