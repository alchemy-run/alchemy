/** A control plane and a pool of nodes on Hetzner Cloud. */
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import * as Layer from "effect/Layer";

export const Cluster = RivetHetzner.ControlPlane("Rivet");
export const Default = RivetHetzner.Pool("Default").pipe(Layer.provide(Cluster));
