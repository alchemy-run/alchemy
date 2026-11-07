/** The conformance model, hosted on one Effect Cluster entity. */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as DomainCluster from "@alchemy.run/effect-cluster/Domain";
import * as Effect from "effect/Effect";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";
import { DomainPool } from "./cluster.ts";

export default class DomainObjects extends Cluster.Entity<DomainObjects>()(
  DomainCluster.entity("DomainObjects"),
  { main: import.meta.url, concurrency: "unbounded" },
  DomainCluster.host(ConformanceLive).pipe(Effect.provide(DomainPool)),
) {}
