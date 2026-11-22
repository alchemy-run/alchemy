import * as Azure from "@alchemy.run/azure";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { database } from "./src/database.ts";

export const providers = () =>
  Layer.mergeAll(Azure.providers(), Drizzle.providers(), Alchemy.RandomProvider());

export default Alchemy.Stack(
  "AzurePostgresDrizzleExample",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { server, db } = yield* database;
    const api = yield* Api;
    return {
      url: api.url,
      functionAppName: api.functionAppName,
      resourceGroup: server.resourceGroup,
      serverName: server.serverName,
      host: server.fullyQualifiedDomainName,
      databaseName: db.databaseName,
      adminConnectionString: server.connectionString,
    };
  }),
);
