import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { AllowAzureServices, Sql, Todos } from "./src/resources.ts";

/** Azure resources plus `Alchemy.Random` for the administrator password. */
export const providers = () => Layer.mergeAll(Azure.providers(), Alchemy.RandomProvider());

export default Alchemy.Stack(
  "AzureSqlExample",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const server = yield* Sql;
    const database = yield* Todos;
    const firewall = yield* AllowAzureServices;
    const api = yield* Api;

    return {
      url: api.url,
      resourceGroup: server.resourceGroup,
      serverName: server.serverName,
      databaseName: database.databaseName,
      firewallRuleName: firewall.firewallRuleName,
      functionAppName: api.functionAppName,
    };
  }),
);
