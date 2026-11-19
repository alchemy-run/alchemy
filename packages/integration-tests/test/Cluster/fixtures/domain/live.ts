/** The conformance model, hosted on Effect Cluster entities. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Layer from "effect/Layer";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";
import { DomainPool } from "./cluster.ts";

export const ConformanceClusterLive = ConformanceLive.pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: "DomainObjects",
      main: import.meta.url,
      handler: "ConformanceClusterLive",
      pool: DomainPool,
    }),
  ),
);
