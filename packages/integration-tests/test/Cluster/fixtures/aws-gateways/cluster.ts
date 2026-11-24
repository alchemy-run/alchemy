/**
 * One database in the suite's own VPC, and a pool behind each kind of
 * gateway: an internal load balancer, CloudFront, and a load balancer
 * serving HTTPS on a domain whose DNS lives in Cloudflare.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as ClusterAWS from "@alchemy.run/effect-cluster/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppNetwork } from "./network.ts";

export const Database = ClusterAWS.Database("ClusterGateways", {
  // The network's private subnets, behind its NAT gateway.
  network: Effect.gen(function* () {
    const network = yield* AppNetwork;
    return {
      vpcId: network.vpcId,
      subnetIds: network.privateSubnetIds,
      publicSubnetIds: network.publicSubnetIds,
      cidrBlock: network.vpc.cidrBlock,
      assignPublicIp: false,
    };
  }),
});

export const Private = ClusterAWS.EcsPool("Private", {
  replicas: 1,
  gateway: ClusterAWS.LoadBalancerGateway({ scheme: "internal" }),
}).pipe(Layer.provide(Database));

export const Edge = ClusterAWS.EcsPool("Edge", {
  replicas: 1,
  gateway: ClusterAWS.CloudFrontGateway(),
}).pipe(Layer.provide(Database));

const zone = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
// One name per stage, so users and worktrees never share a record, short
// enough for an ACM certificate (64 characters): the stage's FNV-1a hash.
const stageHash = [...(process.env.ALCHEMY_TEST_STAGE ?? "local")]
  .reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)
  .toString(36);

/** The name the secure pool's gateway serves. */
export const SECURE_DOMAIN = `cluster-gw-${stageHash}.${zone}`;

export const Secure = ClusterAWS.EcsPool("Secure", {
  replicas: 1,
  gateway: ClusterAWS.LoadBalancerGateway({
    domain: { name: SECURE_DOMAIN, dns: Cloudflare.DNS.Adapter() },
  }),
}).pipe(Layer.provide(Database));
