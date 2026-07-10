import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class EventBridgeTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "EventBridgeTestFunction",
) {}

/**
 * Shared infrastructure for the EventBridge bindings fixture:
 * - a custom event bus (PutEvents + consumeBusEvents against a named bus)
 * - one SQS sink queue per consume loop (custom bus + default bus) so the
 *   test can observe delivered events out-of-band via `sqs.receiveMessage`.
 */
export class BusAndQueues extends Context.Service<
  BusAndQueues,
  {
    bus: AWS.EventBridge.EventBus;
    customQueue: AWS.SQS.Queue;
    defaultQueue: AWS.SQS.Queue;
  }
>()("EventBridgeBusAndQueues") {}

export const BusAndQueuesLive = Layer.effect(
  BusAndQueues,
  Effect.gen(function* () {
    const bus = yield* AWS.EventBridge.EventBus("TestBus", {
      name: "alchemy-test-eb-bindings",
    });
    const customQueue = yield* AWS.SQS.Queue("CustomBusSink");
    const defaultQueue = yield* AWS.SQS.Queue("DefaultBusSink");
    return { bus, customQueue, defaultQueue };
  }),
);

export default EventBridgeTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { bus, customQueue, defaultQueue } = yield* BusAndQueues;

    const putEventsCustom = yield* AWS.EventBridge.PutEvents(bus);
    const putEventsDefault = yield* AWS.EventBridge.PutEvents();
    const customSink = yield* AWS.SQS.QueueSink(customQueue);
    const defaultSink = yield* AWS.SQS.QueueSink(defaultQueue);

    // Consume loop on the CUSTOM bus: matching events are forwarded to the
    // custom sink queue where the test observes them out-of-band.
    yield* AWS.EventBridge.consumeBusEvents(
      bus,
      { source: ["alchemy.test.custom"] },
      (events: Stream.Stream<AWS.EventBridge.EventRecord>) =>
        events.pipe(
          Stream.map((event) =>
            JSON.stringify({
              source: event.source,
              detailType: event["detail-type"],
              detail: event.detail,
            }),
          ),
          Stream.run(customSink),
        ),
    );

    // Consume loop on the DEFAULT bus (no bus argument).
    yield* AWS.EventBridge.consumeBusEvents(
      { source: ["alchemy.test.default"] },
      (events: Stream.Stream<AWS.EventBridge.EventRecord>) =>
        events.pipe(
          Stream.map((event) =>
            JSON.stringify({
              source: event.source,
              detailType: event["detail-type"],
              detail: event.detail,
            }),
          ),
          Stream.run(defaultSink),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/publish-custom") {
          const body = (yield* request.json) as unknown as { marker: string };
          const result = yield* putEventsCustom({
            Entries: [
              {
                Source: "alchemy.test.custom",
                DetailType: "TestEvent",
                Detail: JSON.stringify({ marker: body.marker }),
              },
            ],
          });
          return yield* HttpServerResponse.json({
            failedEntryCount: result.FailedEntryCount ?? 0,
            entries: result.Entries ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/publish-default") {
          const body = (yield* request.json) as unknown as { marker: string };
          const result = yield* putEventsDefault({
            Entries: [
              {
                Source: "alchemy.test.default",
                DetailType: "TestEvent",
                Detail: JSON.stringify({ marker: body.marker }),
              },
            ],
          });
          return yield* HttpServerResponse.json({
            failedEntryCount: result.FailedEntryCount ?? 0,
            entries: result.Entries ?? [],
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.EventSource,
          AWS.EventBridge.PutEventsHttp,
          AWS.SQS.QueueSinkHttp,
          BusAndQueuesLive,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp),
      ),
    ),
  ),
);
