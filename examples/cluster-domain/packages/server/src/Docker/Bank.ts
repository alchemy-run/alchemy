import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";
import { hostBank } from "../BankLive.ts";

/** Postgres on the local Docker swarm: where the cluster keeps the bank's state. */
export const Database = ClusterDocker.Database("BankCluster");

/** Two runners on the local Docker swarm. */
export const Pool = ClusterDocker.SwarmPool("Runners", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/**
 * The bank on Effect Cluster entities, in the Docker pool. The runners load
 * this module's default export to host the model; callers reach it through
 * the pool's gateway.
 */
export default hostBank(
  DomainCluster.layerEntities({ name: "Bank", main: import.meta.url, pool: Pool }),
);
