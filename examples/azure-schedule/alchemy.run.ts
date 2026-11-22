import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Monitor from "./src/Monitor.ts";
import { Data, Runs } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureScheduleExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const account = yield* Data;
    const runs = yield* Runs;
    const monitor = yield* Monitor;

    return {
      url: monitor.url,
      functionApp: monitor.functionAppName,
      hostName: monitor.defaultHostName,
      resourceGroup: monitor.resourceGroup,
      storageAccount: account.storageAccountName,
      container: runs.containerName,
    };
  }),
);
