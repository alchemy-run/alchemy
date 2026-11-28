/** The conformance model, hosted on Rivet Durable Objects. */
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Layer from "effect/Layer";
import {
  ConformanceLive,
  ConformanceLiveV1,
  RECEIPT_RETENTION,
} from "../../Domain/conformance/model.ts";
import { DomainPool } from "./domain-cluster.ts";

export const ConformanceRivetLive = ConformanceLive.pipe(
  Layer.provide(
    DomainRivet.layerDurableObjects("DomainObjects", {
      main: import.meta.url,
      handler: "ConformanceRivetLive",
      pool: DomainPool,
      retention: { receipts: RECEIPT_RETENTION },
    }),
  ),
);

/** The model at its next version, for the rebuild case. */
export const ConformanceRivetLiveV1 = ConformanceLiveV1.pipe(
  Layer.provide(
    DomainRivet.layerDurableObjects("DomainObjects", {
      main: import.meta.url,
      handler: "ConformanceRivetLiveV1",
      pool: DomainPool,
      retention: { receipts: RECEIPT_RETENTION },
    }),
  ),
);
