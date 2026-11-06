/** A control plane on ECS and a pool of EC2 nodes in its VPC. */
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import * as Layer from "effect/Layer";

export const Cluster = RivetAWS.EcsControlPlane("Rivet");
export const Default = RivetAWS.Ec2Pool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams.
export const Services = RivetAWS.ServicesPool("Services").pipe(Layer.provide(Cluster));
