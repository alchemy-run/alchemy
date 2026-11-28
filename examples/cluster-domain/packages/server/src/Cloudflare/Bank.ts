import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterCloudflare from "@alchemy.run/effect-cluster/Cloudflare";
import * as Layer from "effect/Layer";
import { hostBank } from "../BankLive.ts";

/**
 * Effect Cluster on Durable Objects: one Worker whose objects are the
 * entity instances, each keeping its own data in its own storage. No
 * database, no runners to place an instance on.
 */
export const Pool = ClusterCloudflare.DurableObjectPool("Runners");

/**
 * The bank on Effect Cluster entities, in the Durable Object pool. The
 * pool's Worker imports this module's default export to host the model;
 * callers reach it through the pool's gateway.
 */
export default hostBank(
  DomainCluster.layerEntities().pipe(
    Layer.provide(Cluster.layerObjectHost("Bank", { main: import.meta.url, pool: Pool })),
  ),
);
