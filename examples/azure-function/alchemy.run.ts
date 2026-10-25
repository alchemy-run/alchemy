import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Data, Files } from "./src/Files.ts";

export default Alchemy.Stack(
  "AzureFunctionExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    const data = yield* Data;
    const files = yield* Files;
    return {
      url: api.url,
      functionAppName: api.functionAppName,
      resourceGroup: api.resourceGroup,
      principalId: api.principalId,
      hostStorageAccount: api.storageAccountName,
      storageAccount: data.storageAccountName,
      container: files.containerName,
      containerId: files.containerId,
    };
  }),
);
