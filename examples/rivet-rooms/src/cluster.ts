import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

export const Cluster = RivetDocker.SwarmControlPlane("Rivet");

export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
