/** The desk and its Helper, on one Effect Cluster entity. */
import * as AI from "@alchemy.run/ai";
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Layer from "effect/Layer";
import { Desk, HandoverLive, HelperPlayed } from "../desk.ts";
import { HostedPool } from "./cluster.ts";

/** The desk. Its policy holds the Helper, so it still needs one. */
const DeskLive = Desk.layer(HandoverLive).pipe(Layer.provide(DomainCluster.layerEntities()));

/** Each Helper session an entity id of its own, with the desk it closes tickets on. */
const HelperSessions = AI.layerObjects(HelperPlayed.pipe(Layer.provide(DeskLive)));

export default DeskLive.pipe(
  Layer.provideMerge(HelperSessions),
  Layer.provide(Cluster.layerObjectHost("Hosted", { main: import.meta.url, pool: HostedPool })),
);
