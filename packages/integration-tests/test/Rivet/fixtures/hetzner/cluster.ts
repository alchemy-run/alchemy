/** A control plane and a pool of nodes on Hetzner Cloud. */
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import * as Layer from "effect/Layer";

export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
export const Default = RivetHetzner.ServerPool("Default").pipe(Layer.provide(Cluster));
// Rivet Services on a Hetzner Server: Durable Streams.
export const Services = RivetHetzner.ServicesPool("Services").pipe(Layer.provide(Cluster));
