/**
 * One database in the suite's own VPC, and a pool behind each kind of
 * gateway: an internal load balancer, CloudFront, and a load balancer
 * serving HTTPS on a domain whose DNS lives in Cloudflare.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as ClusterAWS from "@alchemy.run/effect-cluster/AWS";
import * as Layer from "effect/Layer";
import { AppNetwork } from "./network.ts";

export const Database = ClusterAWS.Database("ClusterGateways", { network: AppNetwork });

export const Private = ClusterAWS.EcsPool("Private", {
  replicas: 1,
  gateway: ClusterAWS.LoadBalancerGateway({ scheme: "internal" }),
}).pipe(Layer.provide(Database));

export const Edge = ClusterAWS.EcsPool("Edge", {
  replicas: 1,
  gateway: ClusterAWS.CloudFrontGateway(),
}).pipe(Layer.provide(Database));

const zone = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
// One name per stage, so users and worktrees never share a record.
const stage = (process.env.ALCHEMY_TEST_STAGE ?? "local")
  .toLowerCase()
  .replaceAll(/[^a-z0-9-]/g, "-")
  .slice(0, 40);

/** The name the secure pool's gateway serves. */
export const SECURE_DOMAIN = `cluster-gw-${stage}.${zone}`;

export const Secure = ClusterAWS.EcsPool("Secure", {
  replicas: 1,
  gateway: ClusterAWS.LoadBalancerGateway({
    domain: { name: SECURE_DOMAIN, dns: Cloudflare.DNS.Adapter() },
  }),
}).pipe(Layer.provide(Database));
