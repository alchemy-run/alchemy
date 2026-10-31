/** A control plane on Compute Engine and a pool on a Cloud Run worker pool. */
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import * as Layer from "effect/Layer";

export const Cluster = RivetGCP.ComputeControlPlane("Rivet");
export const Default = RivetGCP.WorkerPool("Default").pipe(Layer.provide(Cluster));
