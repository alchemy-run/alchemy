/**
 * The Railway suite's cluster: Railway Postgres and a runner Service per
 * pool, in the Railway suites' partition of their shared project.
 */
import * as ClusterRailway from "@alchemy.run/effect-cluster/Railway";
import * as Layer from "effect/Layer";
import { Partition, Site } from "../../../Railway/fixtures/suite-env.ts";

export const Database = ClusterRailway.Database("Cluster", {
  project: Site,
  environment: Partition,
});

export const Default = ClusterRailway.ServicePool("Default").pipe(Layer.provide(Database));

/** A pool of its own for the external program. */
export const Legacy = ClusterRailway.ServicePool("Legacy").pipe(Layer.provide(Database));
