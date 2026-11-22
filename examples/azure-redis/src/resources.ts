import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * The Azure Managed Redis cluster: the smallest SKU (`Balanced_B0`)
 * without high availability, so one node and no replica. Creating it
 * takes about 5-10 minutes; the deploy waits until it is `Running`.
 */
export const Cache = Azure.Redis.ManagedRedis("Cache", {
  sku: "Balanced_B0",
  highAvailability: "Disabled",
});

/**
 * The cluster's one database (always named `default`), where the
 * counters live.
 *
 * - `EnterpriseCluster` puts one endpoint in front of every shard, so a
 *   client that does not follow `MOVED` redirects works. The default,
 *   `OSSCluster`, needs a cluster-aware client.
 * - Access keys stay disabled (the default): the Function authenticates
 *   with a Microsoft Entra ID token for its managed identity.
 */
export const Counters = Effect.gen(function* () {
  const cache = yield* Cache;
  return yield* Azure.Redis.ManagedRedisDatabase("Counters", {
    cluster: cache.clusterName,
    clusteringPolicy: "EnterpriseCluster",
  });
});
