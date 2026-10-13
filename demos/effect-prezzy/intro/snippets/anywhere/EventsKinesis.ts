import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.Kinesis.Stream("Messages");

    yield* AWS.Kinesis.consumeStreamRecords(source, { startingPosition: "LATEST" }, (records) =>
      records.pipe(Stream.runForEach(Effect.log)),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.StreamEventSource)),
);
// #endregion show
