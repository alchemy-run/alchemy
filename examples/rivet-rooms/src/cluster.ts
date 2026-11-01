import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

export const Cluster = RivetDocker.ControlPlane("Rivet");

export const Default = RivetDocker.Pool("Default").pipe(Layer.provide(Cluster));
