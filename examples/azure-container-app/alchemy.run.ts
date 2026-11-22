import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Environment, Notes } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureContainerAppExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const environment = yield* Environment;
    const notes = yield* Notes;
    const api = yield* Api;
    return {
      url: api.url,
      appName: api.containerAppName,
      resourceGroup: api.resourceGroup,
      principalId: api.principalId,
      environmentName: environment.environmentName,
      containerId: notes.containerId,
    };
  }),
);
