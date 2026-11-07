/** The conformance model, hosted on one Rivet class. */
import * as Rivet from "@alchemy.run/rivet";
import * as DomainRivet from "@alchemy.run/rivet/Domain";
import * as Effect from "effect/Effect";
import { ConformanceLive } from "../../Domain/conformance/model.ts";
import { DomainPool } from "./domain-cluster.ts";

export default class DomainObjects extends Rivet.DurableObject<DomainObjects>()(
  "DomainObjects",
  { main: import.meta.url },
  DomainRivet.host(ConformanceLive).pipe(Effect.provide(DomainPool)),
) {}
