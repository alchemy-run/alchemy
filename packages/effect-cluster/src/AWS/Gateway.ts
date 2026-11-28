import type { CloudFrontGateway } from "./CloudFrontGateway.ts";
import type { LoadBalancerGateway } from "./LoadBalancerGateway.ts";

/**
 * Where callers reach a pool's gateway: `ClusterAWS.LoadBalancerGateway(…)`
 * or `ClusterAWS.CloudFrontGateway(…)`.
 */
export type Gateway = LoadBalancerGateway | CloudFrontGateway;
