import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Data, Files, Jobs } from "./src/Storage.ts";

export default Alchemy.Stack(
  "azure-dev",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const data = yield* Data;
    const files = yield* Files;
    const jobs = yield* Jobs;
    return {
      api: api.url,
      functionAppName: api.functionAppName,
      functionAppId: api.functionAppId,
      resourceGroup: api.resourceGroup,
      storageAccount: data.storageAccountName,
      container: files.containerName,
      containerId: files.containerId,
      queue: jobs.queueName,
    };
  }),
);
