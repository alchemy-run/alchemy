/** A control plane and a pool of nodes on Fly.io. */
import * as RivetFly from "@alchemy.run/rivet/Fly";
import * as Layer from "effect/Layer";

export const Cluster = RivetFly.MachineControlPlane("Rivet");
export const Default = RivetFly.MachinePool("Default").pipe(Layer.provide(Cluster));
