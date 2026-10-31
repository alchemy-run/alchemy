import * as ECS from "@alchemy.run/aws/ECS";
import * as Effect from "effect/Effect";
import { makePoolLayer, NODE_DOCKERFILE, type PoolSettings } from "../internal/PoolHost.ts";
import { nodeEnvironment, poolNetworkOf, resolvePoolNetwork } from "./internal/Pool.ts";

export interface EcsPoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * CPU units of each node (1024 = 1 vCPU).
   * @default 512
   */
  cpu?: number;
  /**
   * Memory of each node, in MiB.
   * @default 1024
   */
  memory?: number;
  /**
   * CPU architecture of the nodes. Images are built for it on the deploying
   * machine, so match it to that machine to skip emulation.
   * @default "X86_64"
   */
  architecture?: "X86_64" | "ARM64";
  /**
   * IPv4 CIDR block of the pool's own VPC, created when its cluster has no
   * VPC for nodes to join (Rivet Cloud, or a control plane outside AWS).
   * @default "10.43.0.0/16"
   */
  cidrBlock?: string;
}

/**
 * Run a pool's nodes on ECS Fargate: a pool on the control plane, and an
 * ECS service whose tasks host every `Rivet.DurableObject` given this pool.
 * Nodes only connect out to the control plane, so they run in public
 * subnets with no load balancer and no inbound rules: the control plane's
 * VPC with `RivetAWS.Ec2ControlPlane`, and a VPC of the pool's own with any
 * other control plane (`RivetCloud.ControlPlane`, `Rivet.ControlPlane`).
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on ECS
 * **Example:** A pool of two nodes
 * ```typescript
 * export const Cluster = RivetAWS.Ec2ControlPlane("Rivet");
 * export const Default = RivetAWS.EcsPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * **Example:** Larger Graviton nodes
 * ```typescript
 * export const Default = RivetAWS.EcsPool("Default", {
 *   cpu: 2048,
 *   memory: 4096,
 *   architecture: "ARM64",
 * }).pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const EcsPool = (id: string, options: EcsPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetAWS.EcsPool",
    id,
    settings: options,
    expected: "an AWS VPC",
    network: poolNetworkOf,
    nodes: (nodes) =>
      Effect.gen(function* () {
        const { program } = nodes;
        const network = yield* resolvePoolNetwork(id, nodes.network, options.cidrBlock);
        const cluster = yield* ECS.Cluster(`${id}Cluster`, {});
        // Every class the pool hosts is bundled into its node image.
        yield* ECS.Service(`${id}Nodes`, {
          ...program,
          cluster,
          dockerfile: { content: NODE_DOCKERFILE },
          desiredCount: options.replicas ?? 1,
          cpu: options.cpu ?? 512,
          memory: options.memory ?? 1024,
          runtimePlatform: {
            cpuArchitecture: options.architecture ?? "X86_64",
            operatingSystemFamily: "LINUX",
          },
          vpcId: network.vpcId,
          subnets: [...network.subnetIds],
          securityGroups: [network.securityGroupId],
          assignPublicIp: true,
          env: nodeEnvironment(nodes),
        });
      }),
  });
