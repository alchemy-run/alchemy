/** The conformance model at its next version, for the rebuild case, on the same entity. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Layer from "effect/Layer";
import { ConformanceLiveV1, RECEIPT_RETENTION } from "../../../Domain/conformance/model.ts";
import { DomainPool } from "./cluster.ts";

export default ConformanceLiveV1.pipe(
  Layer.provide(
    // Swept often enough for the retention case to see a receipt go.
    DomainCluster.layerEntities({
      retention: { receipts: RECEIPT_RETENTION, interval: "3 seconds" },
    }),
  ),
  Layer.provide(
    Cluster.layerObjectHost("DomainObjects", { main: import.meta.url, pool: DomainPool }),
  ),
);
