import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.SQS.Queue("Messages");

    yield* AWS.SQS.consumeQueueMessages(
      source,
      (records) => records.pipe(Stream.runForEach(Effect.log)),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
);
// #endregion show
