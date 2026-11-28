/** The desk and its Helper, on one Rivet Durable Object class. */
import * as AI from "@alchemy.run/ai";
import * as DomainRivet from "@alchemy.run/domain/Rivet";
import * as Rivet from "@alchemy.run/rivet";
import * as Layer from "effect/Layer";
import { Desk, HandoverLive, HelperPlayed } from "../desk.ts";
import { HostedPool } from "./cluster.ts";

/** The desk. Its policy holds the Helper, so it still needs one. */
const DeskLive = Desk.layer(HandoverLive).pipe(Layer.provide(DomainRivet.layerDurableObjects()));

/** Each Helper session in an object of its own, with the desk it closes tickets on. */
const HelperSessions = AI.layerObjects(HelperPlayed.pipe(Layer.provide(DeskLive)));

export default DeskLive.pipe(
  Layer.provideMerge(HelperSessions),
  Layer.provide(Rivet.layerObjectHost("Hosted", { main: import.meta.url, pool: HostedPool })),
);
