/** A pool of nodes on Railway, on a control plane on Hetzner Cloud. */
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import * as RivetRailway from "@alchemy.run/rivet/Railway";
import * as Layer from "effect/Layer";

export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
export const Default = RivetRailway.ServicePool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams.
export const Services = RivetRailway.ServicesPool("Services").pipe(Layer.provide(Cluster));
