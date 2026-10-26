import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Account, Changes, Database, Leases, Todos } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "AzureCosmosExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const account = yield* Account;
    const database = yield* Database;
    const todos = yield* Todos;
    const changes = yield* Changes;
    const leases = yield* Leases;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.url,
      resourceGroup: account.resourceGroup,
      accountName: account.accountName,
      databaseName: database.databaseName,
      containers: {
        todos: todos.containerName,
        changes: changes.containerName,
        leases: leases.containerName,
      },
      apiApp: api.functionAppName,
      apiPrincipalId: api.principalId,
      workerApp: worker.functionAppName,
      workerPrincipalId: worker.principalId,
    };
  }),
);
