/** A control plane and a pool of nodes on Hetzner Cloud. */
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import * as Layer from "effect/Layer";

/**
 * The suite's Servers: Hetzner often has no `cx23` (the default) left in
 * its European locations, and a deploy fails when it runs out midway.
 */
export const SERVER_TYPE = "cpx22";

export const Cluster = RivetHetzner.ServerControlPlane("Rivet", {
  serverType: SERVER_TYPE,
  edgeServerType: SERVER_TYPE,
});
export const Default = RivetHetzner.ServerPool("Default", { serverType: SERVER_TYPE }).pipe(
  Layer.provide(Cluster),
);
// Rivet Services on a Hetzner Server: Durable Streams.
export const Services = RivetHetzner.ServicesPool("Services", { serverType: SERVER_TYPE }).pipe(
  Layer.provide(Cluster),
);
