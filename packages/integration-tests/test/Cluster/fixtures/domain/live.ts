/** The conformance model, hosted on Effect Cluster entities. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Layer from "effect/Layer";
import { ConformanceLive, ConformanceLiveV1 } from "../../../Domain/conformance/model.ts";
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

/** The model at its next version, for the rebuild case. */
export const ConformanceClusterLiveV1 = ConformanceLiveV1.pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: "DomainObjects",
      main: import.meta.url,
      handler: "ConformanceClusterLiveV1",
      pool: DomainPool,
    }),
  ),
);
