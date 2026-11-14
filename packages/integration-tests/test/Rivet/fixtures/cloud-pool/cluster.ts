/**
 * A Rivet Cloud cluster whose nodes Rivet runs too. The free plan allows one
 * runner node per cluster, so Rivet Services runs on ECS Fargate.
 */
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import * as RivetCloud from "@alchemy.run/rivet/Cloud";
import * as Layer from "effect/Layer";

export const Cluster = RivetCloud.ControlPlane("Rivet");
export const Default = RivetCloud.Pool("Default", { machineType: "e2-small" }).pipe(
  Layer.provide(Cluster),
);
// Rivet Services: Durable Streams.
export const Services = RivetAWS.ServicesPool("Services").pipe(Layer.provide(Cluster));
