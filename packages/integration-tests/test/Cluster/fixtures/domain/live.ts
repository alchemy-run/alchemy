/** The conformance model, hosted on Effect Cluster entities. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Layer from "effect/Layer";
import {
  ConformanceLive,
  ConformanceLiveV1,
  RECEIPT_RETENTION,
} from "../../../Domain/conformance/model.ts";
import { DomainPool } from "./cluster.ts";

export const ConformanceClusterLive = ConformanceLive.pipe(
  Layer.provide(
    DomainCluster.layerEntities("DomainObjects", {
      main: import.meta.url,
      handler: "ConformanceClusterLive",
      pool: DomainPool,
      // Swept often enough for the retention case to see a receipt go.
      retention: { receipts: RECEIPT_RETENTION, interval: "3 seconds" },
    }),
  ),
);

/** The model at its next version, for the rebuild case. */
export const ConformanceClusterLiveV1 = ConformanceLiveV1.pipe(
  Layer.provide(
    DomainCluster.layerEntities("DomainObjects", {
      main: import.meta.url,
      handler: "ConformanceClusterLiveV1",
      pool: DomainPool,
      // Swept often enough for the retention case to see a receipt go.
      retention: { receipts: RECEIPT_RETENTION, interval: "3 seconds" },
    }),
  ),
);
