/** The conformance model, hosted on Rivet Durable Objects. */
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Layer from "effect/Layer";
import { ConformanceLive } from "../../Domain/conformance/model.ts";
import { DomainPool } from "./domain-cluster.ts";

export const ConformanceRivetLive = ConformanceLive.pipe(
  Layer.provide(
    DomainRivet.layerDurableObjects({
      name: "DomainObjects",
      main: import.meta.url,
      handler: "ConformanceRivetLive",
      pool: DomainPool,
    }),
  ),
);
