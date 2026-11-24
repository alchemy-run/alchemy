import type { Input } from "alchemy/Input";
import type * as Effect from "effect/Effect";

/**
 * A VPC the cluster runs in, by id. Any resource's attributes fit: a
 * lookup's (`EC2.Vpc.lookup({ name }).vpcId`), or a declaration's or
 * another stack's (`EC2.Vpc.ref(…)`) inside an Effect that yields it.
 */
export interface Network {
  /** The VPC's id. */
  readonly vpcId: Input<string>;
  /**
   * The subnets the database, runners and gateway run in. RDS requires two
   * Availability Zones.
   */
  readonly subnetIds: ReadonlyArray<Input<string>>;
  /**
   * Subnets with a route to an internet gateway, for an internet-facing
   * gateway's load balancer. Defaults to `subnetIds`.
   */
  readonly publicSubnetIds?: ReadonlyArray<Input<string>>;
  /**
   * The VPC's IPv4 range, which an internal gateway admits when given no
   * `ingress`.
   */
  readonly cidrBlock?: Input<string>;
  /**
   * Whether runners take a public IP. In subnets without a NAT gateway, it
   * is how runners pull their image and reach other APIs; set `false` in
   * private subnets behind one.
   * @default true
   */
  readonly assignPublicIp?: boolean;
}

/**
 * A {@link Network}, or an Effect that yields the resources it comes from
 * (an `EC2.Network` declaration, `EC2.Vpc.ref(…)`) and returns one.
 */
export type NetworkInput<N extends Network = Network, E = never, R = never> =
  | N
  | Effect.Effect<N, E, R>;
