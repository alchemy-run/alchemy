import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// #region show
export default AWS.Lambda.Function(
  "Archive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const source = yield* AWS.DynamoDB.Table("Messages", { partitionKey: "room", attributes: { room: "S" } });

    yield* AWS.DynamoDB.consumeTableChanges(source, { streamViewType: "NEW_IMAGE" }, (records) =>
      records.pipe(Stream.runForEach((record) => Effect.log(record))),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.TableEventSource)),
);
// #endregion show
