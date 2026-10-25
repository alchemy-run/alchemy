import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Job, JobService } from "./JobService.ts";

const toJob = (out: { Item?: Record<string, { S?: string } | undefined> }): Job | null =>
  out.Item ? { id: out.Item.id?.S ?? "", status: out.Item.status?.S ?? "" } : null;

// #region show
export const JobServiceDynamo = Layer.effect(
  JobService,
  Effect.gen(function* () {
    const jobs = yield* AWS.DynamoDB.Table("Jobs", { partitionKey: "id", attributes: { id: "S" } });
    const getItem = yield* AWS.DynamoDB.GetItem(jobs);
    return {
      getJob: (id: string) => getItem({ Key: { id: { S: id } } }).pipe(Effect.map(toJob)) /*hide*/.pipe(Effect.orDie) /*end*/,
    };
  }),
) /*hide*/.pipe(Layer.provide(AWS.DynamoDB.GetItemHttp)) /*end*/;
// #endregion show
