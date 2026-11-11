/** The contract model, hosted on Effect Cluster entities of its own, on the same pool. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Layer from "effect/Layer";
import { DomainPool } from "./cluster.ts";
import { ContractLive } from "./contract-model.ts";

export const ContractClusterLive = ContractLive.pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: "ContractObjects",
      main: import.meta.url,
      handler: "ContractClusterLive",
      pool: DomainPool,
    }),
  ),
);
