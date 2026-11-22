import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import JobFunction from "./src/JobFunction.ts";
import { Data, Jobs } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureFunctionHttpApiExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const data = yield* Data;
    const jobs = yield* Jobs;
    const api = yield* JobFunction;

    return {
      url: api.url,
      functionAppName: api.functionAppName,
      principalId: api.principalId,
      resourceGroup: data.resourceGroup,
      storageAccount: data.storageAccountName,
      table: jobs.tableName,
      tableId: jobs.tableId,
    };
  }),
);
