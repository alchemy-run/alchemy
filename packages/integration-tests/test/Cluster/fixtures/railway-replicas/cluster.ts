/**
 * The Railway replicas suite's cluster: Railway Postgres and one pool, as
 * three replicas or one. Both declarations are the same pool (`Replicas`):
 * deploying one after the other changes its replica count in place.
 */
import * as ClusterRailway from "@alchemy.run/effect-cluster/Railway";
import * as Layer from "effect/Layer";
import { Partition, Site } from "../../../Railway/fixtures/suite-env.ts";

export const Database = ClusterRailway.Database("ReplicasCluster", {
  project: Site,
  environment: Partition,
});

export const Three = ClusterRailway.ServicePool("Replicas", { replicas: 3 }).pipe(
  Layer.provide(Database),
);

export const One = ClusterRailway.ServicePool("Replicas", { replicas: 1 }).pipe(
  Layer.provide(Database),
);
