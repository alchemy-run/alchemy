/** A control plane and a pool of nodes, both on Compute Engine. */
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import * as Layer from "effect/Layer";

export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet");
export const Default = RivetGCP.ComputeEnginePool("Default").pipe(Layer.provide(Cluster));
