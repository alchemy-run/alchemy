/** The desk and its Helper, both on Rivet Durable Objects. */
import * as AIRivet from "@alchemy.run/ai/Rivet";
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Layer from "effect/Layer";
import { Desk, HandoverLive, HelperPlayed } from "../desk.ts";
import { HostedPool } from "./cluster.ts";

/** The desk. Its policy holds the Helper, so it still needs one. */
const DeskLive = Desk.layer(HandoverLive).pipe(
  Layer.provide(
    DomainRivet.layerDurableObjects("DeskObjects", {
      main: import.meta.url,
      handler: "HostedRivetLive",
      pool: HostedPool,
    }),
  ),
);

/** Each Helper session in a Durable Object of its own, with the desk it closes tickets on. */
const HelperSessions = AIRivet.layerDurableObjects(
  "HelperSessions",
  HelperPlayed.pipe(Layer.provide(DeskLive)),
  {
    main: import.meta.url,
    handler: "HostedRivetLive",
    pool: HostedPool,
  },
);

export const HostedRivetLive = DeskLive.pipe(Layer.provideMerge(HelperSessions));
