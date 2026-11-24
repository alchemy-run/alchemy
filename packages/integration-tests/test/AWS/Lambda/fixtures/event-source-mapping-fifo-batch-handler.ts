import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// A FIFO queue consumed in batches of 10,000, which Lambda accepts only when
// the mapping runs in provisioned mode.
export class EventSourceMappingFifoBatchFunction extends Lambda.Function<EventSourceMappingFifoBatchFunction>()(
  "EventSourceMappingFifoBatchFunction",
) {}

export default EventSourceMappingFifoBatchFunction.make(
  {
    main: import.meta.url,
    functionUrl: false,
  },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("EventSourceMappingFifoBatchQueue", { fifo: true });

    yield* SQS.consumeQueueMessages(
      queue,
      {
        batchSize: 10_000,
        maximumBatchingWindow: "5 seconds",
        provisionedPollerConfig: { MinimumPollers: 2, MaximumPollers: 2 },
      },
      () => Effect.void,
    );

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Lambda.QueueEventSource)),
);
