import * as DynamoDB from "@alchemy.run/aws/DynamoDB";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// One Function consuming a DynamoDB stream whose Table's tags change across
// deploys. Retagging updates the Table in place, so its stream (and the
// EventSourceMapping reading it) must survive the deploy.
export class EventSourceMappingTableFunction extends Lambda.Function<EventSourceMappingTableFunction>()(
  "EventSourceMappingTableFunction",
) {}

export const makeTableFunction = (tags: Record<string, string>) =>
  EventSourceMappingTableFunction.make(
    {
      main: import.meta.url,
      functionUrl: false,
    },
    Effect.gen(function* () {
      const table = yield* DynamoDB.Table("EventSourceMappingTable", {
        partitionKey: "pk",
        attributes: { pk: "S" },
        tags,
      });

      yield* DynamoDB.consumeTableChanges(table, { startingPosition: "LATEST" }, () => Effect.void);

      return {
        fetch: Effect.gen(function* () {
          return HttpServerResponse.text("ok");
        }).pipe(Effect.orDie),
      };
    }).pipe(Effect.provide(Layer.mergeAll(Lambda.TableEventSource))),
  );

export default makeTableFunction({ version: "1" });
