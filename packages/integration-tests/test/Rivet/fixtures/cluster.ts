/** The local control plane and the pool every fixture class runs on. */
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

// On a free port, so the suite runs beside itself in other worktrees.
export const Cluster = RivetDocker.SwarmControlPlane("Rivet", { port: 0 });
export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams, on the same control plane.
export const Services = RivetDocker.ServicesPool("Services").pipe(Layer.provide(Cluster));
// A pool of its own for the alarm test that kills its nodes.
export const Abandoned = RivetDocker.SwarmPool("Abandoned").pipe(Layer.provide(Cluster));
