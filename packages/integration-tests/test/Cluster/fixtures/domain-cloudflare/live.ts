/** The conformance model, hosted on Effect Cluster entities in a Durable Object pool. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as ClusterCloudflare from "@alchemy.run/effect-cluster/Cloudflare";
import * as Layer from "effect/Layer";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";

/** The entity that holds the model: its name is in every log line the host writes. */
export const ENTITY = "DomainObjectsOnDurableObjects";

/** Each instance is a Durable Object keeping its rows in its own storage: no database. */
export const DomainDurableObjectPool = ClusterCloudflare.DurableObjectPool("DomainDurableObjects");

export const ConformanceDurableObjectsLive = ConformanceLive.pipe(
  Layer.provide(
    DomainCluster.layerEntities({
      name: ENTITY,
      main: import.meta.url,
      handler: "ConformanceDurableObjectsLive",
      pool: DomainDurableObjectPool,
    }),
  ),
);
