/** The conformance model, hosted on Rivet Durable Objects. */
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Rivet from "@alchemy.run/rivet";
import * as Layer from "effect/Layer";
import { ConformanceLive, RECEIPT_RETENTION } from "../../Domain/conformance/model.ts";
import { DomainPool } from "./domain-cluster.ts";

export default ConformanceLive.pipe(
  Layer.provide(DomainRivet.layerObjects({ retention: { receipts: RECEIPT_RETENTION } })),
  Layer.provide(
    Rivet.layerObjectHost("DomainObjects", { main: import.meta.url, pool: DomainPool }),
  ),
);
