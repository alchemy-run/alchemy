/** The AWS suite's cluster: Postgres on RDS, runners on ECS Fargate. */
import * as ClusterAWS from "@alchemy.run/effect-cluster/AWS";
import * as Layer from "effect/Layer";

export const Database = ClusterAWS.Database("Cluster");

export const Default = ClusterAWS.EcsPool("Default", { replicas: 2 }).pipe(Layer.provide(Database));

/** A pool of its own for the external program. */
export const Legacy = ClusterAWS.EcsPool("Legacy", { replicas: 1 }).pipe(Layer.provide(Database));
