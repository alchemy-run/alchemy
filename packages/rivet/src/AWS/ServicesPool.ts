import * as ECS from "@alchemy.run/aws/ECS";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";
import { poolNetworkOf, resolvePoolNetwork } from "./internal/Pool.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * CPU units of each node (1024 = 1 vCPU).
   * @default 1024
   */
  cpu?: number;
  /**
   * Memory of each node, in MiB.
   * @default 2048
   */
  memory?: number;
  /**
   * IPv4 CIDR block of the VPC the nodes run in, when the control plane has
   * none of its own on AWS.
   * @default "10.43.0.0/16"
   */
  cidrBlock?: string;
}

/**
 * Run Rivet Services on ECS Fargate: the `services` pool on the control
 * plane, and an ECS service running Rivet's prebuilt Services node, which
 * hosts Durable Streams and agentOS. Nodes run in the control plane's VPC
 * with `RivetAWS.Ec2ControlPlane`, and in a VPC of their own otherwise. They
 * take no inbound traffic: callers reach every stream through the control
 * plane's gateway, with its token.
 *
 * ### Running Rivet Services on AWS
 * **Example:** Services next to an EC2 control plane
 * ```typescript
 * export const Cluster = RivetAWS.Ec2ControlPlane("Rivet");
 * export const Services = RivetAWS.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetAWS.ServicesPool",
    id,
    settings: options,
    expected: "an AWS VPC",
    network: poolNetworkOf,
    nodes: (nodes) =>
      Effect.gen(function* () {
        const network = yield* resolvePoolNetwork(id, nodes.network, options.cidrBlock);
        const cluster = yield* ECS.Cluster(`${id}Cluster`, {});
        yield* ECS.Service(`${id}Nodes`, {
          image: nodes.image,
          cluster,
          desiredCount: options.replicas ?? 1,
          cpu: options.cpu ?? 1024,
          memory: options.memory ?? 2048,
          runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
          vpcId: network.vpcId,
          subnets: [...network.subnetIds],
          securityGroups: [network.securityGroupId],
          assignPublicIp: true,
          env: servicesEnvironment(nodes),
        });
      }),
  });
