import * as AWS from "@alchemy.run/aws";
import * as Stripe from "@alchemy.run/stripe";
import { ConsumeEventsEventBridge } from "@alchemy.run/stripe/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The queue the function records each handled event on, for the test to read. */
export class Deliveries extends Context.Service<Deliveries, AWS.SQS.Queue>()(
  "StripeEventBridgeDeliveries",
) {}

export const DeliveriesLive = Layer.effect(Deliveries, AWS.SQS.Queue("StripeDeliveries"));

export default class StripeEventBridgeFunction extends AWS.Lambda.Function<StripeEventBridgeFunction>()(
  "StripeEventBridgeFunction",
  { main: import.meta.url },
  Effect.gen(function* () {
    const queue = yield* Deliveries;
    const record = yield* AWS.SQS.SendMessage(queue);

    yield* Stripe.consumeEvents(
      "Events",
      // A snapshot event and a thin one: each gets its own destination and bus.
      { events: [Stripe.CustomerCreated, Stripe.EventDestinationPing] },
      Effect.fn(function* (event) {
        const body =
          event.type === "customer.created"
            ? { type: event.type, id: event.object.id }
            : { type: event.type, id: event.object.id, related: event.object.relatedObject?.id };
        yield* record({ MessageBody: JSON.stringify(body) }).pipe(Effect.orDie);
      }),
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ConsumeEventsEventBridge, AWS.SQS.SendMessageHttp).pipe(
        Layer.provideMerge(DeliveriesLive),
      ),
    ),
  ),
) {}
