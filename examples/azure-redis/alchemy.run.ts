import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Cache, Counters } from "./src/resources.ts";

export default Alchemy.Stack(
  "AzureRedisExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cache = yield* Cache;
    const counters = yield* Counters;
    const api = yield* Api;

    // Lets the app's managed identity sign in to the database with an
    // Entra ID token (`AUTH <principalId> <token>`). A Function always has
    // a system-assigned identity, so `principalId` is set.
    const access = yield* Azure.Redis.AccessPolicyAssignment("ApiAccess", {
      cluster: counters.cluster,
      database: counters.databaseName,
      objectId: api.principalId.as<string>(),
    });

    return {
      url: api.url,
      functionAppName: api.functionAppName,
      principalId: api.principalId,
      resourceGroup: cache.resourceGroup,
      clusterName: cache.clusterName,
      hostName: counters.hostName,
      port: counters.port,
      databaseName: counters.databaseName,
      accessPolicyAssignmentName: access.accessPolicyAssignmentName,
    };
  }),
);
