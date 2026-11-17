/** A Rivet Cloud cluster and pools of ECS Fargate nodes in a VPC of their own. */
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import * as RivetCloud from "@alchemy.run/rivet/Cloud";
import * as Layer from "effect/Layer";

export const Cluster = RivetCloud.ControlPlane("Rivet");
export const Default = RivetAWS.EcsPool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams.
export const Services = RivetAWS.ServicesPool("Services").pipe(Layer.provide(Cluster));
