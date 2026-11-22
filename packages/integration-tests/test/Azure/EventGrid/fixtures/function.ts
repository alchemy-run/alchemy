import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the Event Grid binding fixture binds. Module-scope so the test
// stack yields the same declarations.

/** Custom topic in the Event Grid schema (the default input schema). */
export const EventGridTopic = Azure.EventGrid.Topic("EgBindingsEventGridTopic", {});
/** Custom topic that accepts CloudEvents v1.0. */
export const CloudEventTopic = Azure.EventGrid.Topic("EgBindingsCloudEventTopic", {
  inputSchema: "CloudEventSchemaV1_0",
});
/** Custom topic that accepts `{ orderId, kind }` events. */
export const CustomTopic = Azure.EventGrid.Topic("EgBindingsCustomTopic", {
  inputSchema: "CustomEventSchema",
  inputSchemaMapping: {
    id: { sourceField: "orderId" },
    eventType: { sourceField: "kind", defaultValue: "Order.Custom" },
    subject: { defaultValue: "orders" },
    dataVersion: { defaultValue: "1.0" },
  },
});

export const Namespace = Azure.EventGrid.Namespace("EgBindingsNamespace", { capacity: 1 });
export const Orders = Effect.gen(function* () {
  const namespace = yield* Namespace;
  return yield* Azure.EventGrid.NamespaceTopic("EgBindingsOrders", {
    namespace: namespace.namespaceName,
    eventRetentionInDays: 1,
  });
});
/** Pull subscription the receive/settle routes work on (`Work.Item` events only). */
export const Workers = Effect.gen(function* () {
  const namespace = yield* Namespace;
  const orders = yield* Orders;
  return yield* Azure.EventGrid.NamespaceTopicEventSubscription("EgBindingsWorkers", {
    namespace: namespace.namespaceName,
    topic: orders.namespaceTopicName,
    queue: { receiveLockDurationInSeconds: 120, maxDeliveryCount: 10 },
    includedEventTypes: ["Work.Item"],
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const cloudEvent = (id: string, type: string) => ({
  id,
  source: "/alchemy/eventgrid-bindings",
  type,
  specversion: "1.0",
  datacontenttype: "application/json",
  data: { id },
});

/**
 * Effect Function with one route per Event Grid data-plane binding. Publish
 * routes take `id`; `/receive` takes the `id` it must see; settle routes
 * take a `token`. Routes answer `{ ok, result | error }` with a 500 on
 * error, so a caller retries through role propagation and a real failure
 * shows the Event Grid error.
 */
export default class EventGridBindingsFunction extends Azure.Functions.Function<EventGridBindingsFunction>()(
  "EgBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const eventGridTopic = yield* EventGridTopic;
    const cloudEventTopic = yield* CloudEventTopic;
    const customTopic = yield* CustomTopic;
    const orders = yield* Orders;
    const workers = yield* Workers;

    const publishEventGridEvents = yield* Azure.EventGrid.PublishEventGridEvents(eventGridTopic);
    const publishCloudEventEvents = yield* Azure.EventGrid.PublishCloudEventEvents(cloudEventTopic);
    const publishCustomEventEvents = yield* Azure.EventGrid.PublishCustomEventEvents(customTopic);
    const publishCloudEvent = yield* Azure.EventGrid.PublishCloudEvent(orders);
    const publishCloudEvents = yield* Azure.EventGrid.PublishCloudEvents(orders);
    const receiveCloudEvents = yield* Azure.EventGrid.ReceiveCloudEvents(workers);
    const acknowledgeCloudEvents = yield* Azure.EventGrid.AcknowledgeCloudEvents(workers);
    const releaseCloudEvents = yield* Azure.EventGrid.ReleaseCloudEvents(workers);
    const rejectCloudEvents = yield* Azure.EventGrid.RejectCloudEvents(workers);
    const renewCloudEventLocks = yield* Azure.EventGrid.RenewCloudEventLocks(workers);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const token = url.searchParams.get("token") ?? "";
        switch (url.pathname) {
          case "/publish-eventgrid":
            return yield* respond(
              Effect.as(
                publishEventGridEvents({
                  body: [
                    {
                      id,
                      subject: `orders/${id}`,
                      eventType: "Order.Created",
                      eventTime: new Date().toISOString(),
                      dataVersion: "1.0",
                      data: { id },
                    },
                  ],
                }),
                { published: id },
              ),
            );
          case "/publish-cloudevent-events":
            return yield* respond(
              Effect.as(publishCloudEventEvents({ body: [cloudEvent(id, "Order.Created")] }), {
                published: id,
              }),
            );
          case "/publish-custom":
            return yield* respond(
              Effect.as(
                publishCustomEventEvents({ body: [{ orderId: id, kind: "Order.Custom" }] }),
                { published: id },
              ),
            );
          case "/publish-cloud-event":
            return yield* respond(
              Effect.as(publishCloudEvent(cloudEvent(id, "Order.Created")), { published: id }),
            );
          case "/publish-cloud-events":
            return yield* respond(
              Effect.as(
                publishCloudEvents({
                  body: [
                    cloudEvent(`${id}-a`, "Order.Created"),
                    cloudEvent(`${id}-b`, "Order.Created"),
                  ],
                }),
                { published: [`${id}-a`, `${id}-b`] },
              ),
            );
          case "/receive":
            return yield* respond(
              Effect.gen(function* () {
                const received = yield* receiveCloudEvents({ maxEvents: 10, maxWaitTime: 10 });
                const match = received.value.find((r) => r.event.id === id);
                // Release everything else so the next route sees it.
                const others = received.value
                  .filter((r) => r !== match)
                  .map((r) => r.brokerProperties.lockToken);
                if (others.length > 0) yield* releaseCloudEvents({ lockTokens: others });
                if (match === undefined) {
                  return yield* Effect.fail(new Error(`event ${id} not received yet`));
                }
                return {
                  id: match.event.id,
                  type: match.event.type,
                  lockToken: match.brokerProperties.lockToken,
                  deliveryCount: match.brokerProperties.deliveryCount,
                };
              }),
            );
          case "/acknowledge":
            return yield* respond(acknowledgeCloudEvents({ lockTokens: [token] }));
          case "/release":
            return yield* respond(releaseCloudEvents({ lockTokens: [token] }));
          case "/reject":
            return yield* respond(rejectCloudEvents({ lockTokens: [token] }));
          case "/renew":
            return yield* respond(renewCloudEventLocks({ lockTokens: [token] }));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.EventGrid.PublishEventGridEventsHttp,
        Azure.EventGrid.PublishCloudEventEventsHttp,
        Azure.EventGrid.PublishCustomEventEventsHttp,
        Azure.EventGrid.PublishCloudEventHttp,
        Azure.EventGrid.PublishCloudEventsHttp,
        Azure.EventGrid.ReceiveCloudEventsHttp,
        Azure.EventGrid.AcknowledgeCloudEventsHttp,
        Azure.EventGrid.ReleaseCloudEventsHttp,
        Azure.EventGrid.RejectCloudEventsHttp,
        Azure.EventGrid.RenewCloudEventLocksHttp,
      ),
    ),
  ),
) {}
