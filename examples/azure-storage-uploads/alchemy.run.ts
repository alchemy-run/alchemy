import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import Indexer from "./src/Indexer.ts";
import { Data, Files, Uploads } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureStorageUploadsExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const account = yield* Data;
    const uploads = yield* Uploads;
    const files = yield* Files;
    const api = yield* Api;
    const indexer = yield* Indexer;

    return {
      url: api.url,
      resourceGroup: account.resourceGroup,
      storageAccount: account.storageAccountName,
      containerName: uploads.containerName,
      tableName: files.tableName,
      apiApp: api.functionAppName,
      indexerApp: indexer.functionAppName,
      apiPrincipalId: api.principalId,
      indexerPrincipalId: indexer.principalId,
      eventSubscriptions: indexer.eventSubscriptions,
    };
  }),
);
