import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import ReportJob from "./src/ReportJob.ts";
import { Bucket, Data, Env } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureContainerAppJobExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const env = yield* Env;
    const account = yield* Data;
    const bucket = yield* Bucket;
    const job = yield* ReportJob;
    const api = yield* Api;
    return {
      url: api.url,
      resourceGroup: job.resourceGroup,
      jobName: job.jobName,
      environmentName: env.environmentName,
      storageAccount: account.storageAccountName,
      container: bucket.containerName,
    };
  }),
);
