/** A control plane on EC2 and a Fargate pool in its VPC. */
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import * as Layer from "effect/Layer";

export const Cluster = RivetAWS.Ec2ControlPlane("Rivet");
// Built on the deploying machine; Graviton matches Apple silicon.
export const Default = RivetAWS.EcsPool("Default", { architecture: "ARM64" }).pipe(
  Layer.provide(Cluster),
);
// Rivet Services on Fargate in the same VPC: Durable Streams.
export const Services = RivetAWS.ServicesPool("Services").pipe(Layer.provide(Cluster));
