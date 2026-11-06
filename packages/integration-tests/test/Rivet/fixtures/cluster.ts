/** The local control plane and the pool every fixture class runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

export const CONTROL_PLANE_PORT = 16440;
export const FRONT_PORT = 18440;

export const Cluster = RivetDocker.SwarmControlPlane("Rivet", { port: CONTROL_PLANE_PORT });
export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams, on the same control plane.
export const Services = RivetDocker.ServicesPool("Services").pipe(Layer.provide(Cluster));
