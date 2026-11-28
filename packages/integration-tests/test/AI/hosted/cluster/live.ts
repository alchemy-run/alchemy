/** The desk and its Helper, both on Effect Cluster entities. */
import * as AICluster from "@alchemy.run/ai/EffectCluster";
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Layer from "effect/Layer";
import { Desk, HandoverLive, HelperPlayed } from "../desk.ts";
import { HostedPool } from "./cluster.ts";

/** The desk. Its policy holds the Helper, so it still needs one. */
const DeskLive = Desk.layer(HandoverLive).pipe(
  Layer.provide(
    DomainCluster.layerEntities("DeskObjects", {
      main: import.meta.url,
      handler: "HostedClusterLive",
      pool: HostedPool,
    }),
  ),
);

/** Each Helper session an entity of its own, with the desk it closes tickets on. */
const HelperSessions = AICluster.layerEntities(
  "HelperSessions",
  HelperPlayed.pipe(Layer.provide(DeskLive)),
  {
    main: import.meta.url,
    handler: "HostedClusterLive",
    pool: HostedPool,
  },
);

export const HostedClusterLive = DeskLive.pipe(Layer.provideMerge(HelperSessions));
