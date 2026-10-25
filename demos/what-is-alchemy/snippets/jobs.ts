import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
export const Jobs = AWS.DynamoDB.Table("Jobs", {
  partitionKey: "id",
  attributes: { id: "S" },
});

export default AWS.Lambda.Function(
  "Api",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const getItem = yield* AWS.DynamoDB.GetItem(Jobs);

    return {
      fetch: Effect.gen(function* () {
        const job = yield* getItem({ Key: { id: { S: "job-1" } } });
        return HttpServerResponse.text(JSON.stringify(job.Item));
      }) /*hide*/.pipe(Effect.orDie) /*end*/,
    };
  }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
);
// #endregion show
