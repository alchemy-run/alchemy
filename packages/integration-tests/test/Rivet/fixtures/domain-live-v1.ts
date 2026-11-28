/** The conformance model at its next version, for the rebuild case, on the same class. */
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Rivet from "@alchemy.run/rivet";
import * as Layer from "effect/Layer";
import { ConformanceLiveV1, RECEIPT_RETENTION } from "../../Domain/conformance/model.ts";
import { DomainPool } from "./domain-cluster.ts";

export default ConformanceLiveV1.pipe(
  Layer.provide(DomainRivet.layerDurableObjects({ retention: { receipts: RECEIPT_RETENTION } })),
  Layer.provide(
    Rivet.layerObjectHost("DomainObjects", { main: import.meta.url, pool: DomainPool }),
  ),
);
