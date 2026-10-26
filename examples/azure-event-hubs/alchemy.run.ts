import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Hubs, Readings, Results } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "AzureEventHubsExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const hubs = yield* Hubs;
    const readings = yield* Readings;
    const results = yield* Results;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.url,
      resourceGroup: hubs.resourceGroup,
      namespaceName: hubs.namespaceName,
      eventHubName: readings.eventHubName,
      storageAccountName: results.storageAccount,
      containerName: results.containerName,
      apiApp: api.functionAppName,
      workerApp: worker.functionAppName,
    };
  }),
);
