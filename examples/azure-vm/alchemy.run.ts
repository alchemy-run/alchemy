import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { Jobs, Results } from "./src/resources.ts";
import Server from "./src/Server.ts";

export default Alchemy.Stack(
  "AzureVmExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const server = yield* Server;
    const jobs = yield* Jobs;
    const results = yield* Results;
    return {
      url: server.url,
      vmName: server.virtualMachineName,
      resourceGroup: server.resourceGroup,
      principalId: server.principalId,
      queueId: jobs.queueId,
      containerId: results.containerId,
    };
  }),
);
