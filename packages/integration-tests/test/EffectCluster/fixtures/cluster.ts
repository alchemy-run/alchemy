/** The local database and the runners every fixture entity runs on. */
import * as EffectClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const FRONT_PORT = 18610;

export const Database = EffectClusterDocker.Database("Cluster");

export const Default = EffectClusterDocker.Runners("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);
