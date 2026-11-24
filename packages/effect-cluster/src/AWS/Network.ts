import type { NetworkResources } from "@alchemy.run/aws/EC2/Network";
import type { Subnet } from "@alchemy.run/aws/EC2/Subnet";
import type { Vpc } from "@alchemy.run/aws/EC2/Vpc";
import type * as Effect from "effect/Effect";

/**
 * A resource as a cluster prop: a declaration (`EC2.Vpc("App", …)`), a
 * reference to another stack's (`EC2.Vpc.ref("AppVpc", { stack })`), or one
 * nobody manages (`EC2.Vpc.lookup({ name })`).
 */
export type ResourceInput<T, E = never, R = never> = T | Effect.Effect<T, E, R>;

/** A VPC and the subnets the cluster runs in, given resource by resource. */
export interface VpcNetwork<E = never, R = never> {
  /** The VPC. */
  readonly vpc: ResourceInput<Vpc, E, R>;
  /**
   * The subnets the database, runners and gateway run in. RDS requires two
   * Availability Zones.
   */
  readonly subnets: ReadonlyArray<ResourceInput<Subnet, E, R>>;
  /**
   * Subnets with a route to an internet gateway, for an internet-facing
   * gateway's load balancer. Defaults to `subnets`.
   */
  readonly publicSubnets?: ReadonlyArray<ResourceInput<Subnet, E, R>>;
  /**
   * Whether runners take a public IP. Give subnets without a NAT gateway
   * `true`: runners pull their image and reach other APIs through it.
   * @default false
   */
  readonly assignPublicIp?: boolean;
}

/**
 * The network a cluster runs in: an `EC2.Network` declaration (its private
 * subnets when it has a NAT gateway, else its public ones), or a VPC and
 * subnets given resource by resource.
 */
export type NetworkInput<E = never, R = never> =
  | Effect.Effect<NetworkResources, E, R>
  | VpcNetwork<E, R>;
