import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Data, Jobs, Results } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "AzureStorageQueueExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // Everything goes into the stack's resource group,
    // "AzureStorageQueueExample-<stage>", which Alchemy creates and deletes.
    const data = yield* Data;
    const jobs = yield* Jobs;
    const results = yield* Results;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.url,
      resourceGroup: data.resourceGroup,
      storageAccount: data.storageAccountName,
      queueName: jobs.queueName,
      queueId: jobs.queueId,
      containerName: results.containerName,
      apiApp: api.functionAppName,
      apiPrincipalId: api.principalId,
      workerApp: worker.functionAppName,
      workerPrincipalId: worker.principalId,
    };
  }),
);
