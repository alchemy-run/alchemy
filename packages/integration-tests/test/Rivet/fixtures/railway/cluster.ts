/** A pool of nodes on Railway, on a control plane on Hetzner Cloud. */
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import * as RivetRailway from "@alchemy.run/rivet/Railway";
import * as Layer from "effect/Layer";

export const Cluster = RivetHetzner.ControlPlane("Rivet");
export const Default = RivetRailway.Pool("Default").pipe(Layer.provide(Cluster));
