import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as ClusterAWS from "@alchemy.run/effect-cluster/AWS";
import * as Layer from "effect/Layer";
import { hostBank } from "../BankLive.ts";

/** Postgres on RDS, in a VPC of its own: where the cluster keeps the bank's state. */
export const Database = ClusterAWS.Database("BankCluster");

/** Two runners on ECS Fargate, in the database's VPC, behind a load-balanced gateway. */
export const Pool = ClusterAWS.EcsPool("Runners", { replicas: 2 }).pipe(Layer.provide(Database));

/**
 * The bank on Effect Cluster entities, in the ECS pool. The runners load
 * this module's default export to host the model; callers reach it through
 * the pool's gateway.
 */
export default hostBank(
  DomainCluster.layerEntities({ name: "Bank", main: import.meta.url, pool: Pool }),
);
