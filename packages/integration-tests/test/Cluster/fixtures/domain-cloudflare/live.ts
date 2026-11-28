/** The conformance model, hosted on Effect Cluster entities in a Durable Object pool. */
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as ClusterCloudflare from "@alchemy.run/effect-cluster/Cloudflare";
import * as Layer from "effect/Layer";
import { ConformanceLive, RECEIPT_RETENTION } from "../../../Domain/conformance/model.ts";

/** The entity that holds the model: its name is in every log line the host writes. */
export const ENTITY = "DomainObjectsOnDurableObjects";

/** Each instance is a Durable Object keeping its rows in its own storage: no database. */
export const DomainDurableObjectPool = ClusterCloudflare.DurableObjectPool("DomainDurableObjects");

export default ConformanceLive.pipe(
  Layer.provide(DomainCluster.layerObjects({ retention: { receipts: RECEIPT_RETENTION } })),
  Layer.provide(
    Cluster.layerObjectHost(ENTITY, { main: import.meta.url, pool: DomainDurableObjectPool }),
  ),
);
