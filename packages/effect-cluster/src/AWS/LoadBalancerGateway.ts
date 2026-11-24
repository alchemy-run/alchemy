import type { DnsConfig } from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";

/** Who may connect to a load balancer gateway. */
export type GatewayIngress =
  | {
      /** An IPv4 range, e.g. a peered VPC's or a VPN's. */
      readonly cidrIpv4: string;
    }
  | {
      /** A managed prefix list. */
      readonly prefixListId: Input<string>;
    }
  | {
      /** Members of a security group, e.g. the callers' own. */
      readonly securityGroupId: Input<string>;
    };

/** The custom domain a load balancer gateway serves HTTPS on. */
export interface GatewayDomain {
  /** The domain name, e.g. `cluster.example.com`. */
  readonly name: string;
  /** More names served by the same gateway. */
  readonly aliases?: string[];
  /**
   * ARN of an existing ACM certificate in the pool's region. When omitted,
   * a DNS-validated certificate is created.
   */
  readonly cert?: string;
  /**
   * The DNS host for the certificate's validation and the domain's
   * records. Omitted: Route 53, in the public hosted zone that contains the
   * name. Pass `Cloudflare.DNS.Adapter()` for a domain whose DNS lives in
   * Cloudflare.
   */
  readonly dns?: DnsConfig;
}

export interface LoadBalancerGatewayOptions {
  /**
   * `"internet-facing"` serves callers anywhere; `"internal"` only callers
   * in the pool's VPC (or networks connected to it).
   * @default "internet-facing"
   */
  readonly scheme?: "internet-facing" | "internal";
  /**
   * Who may connect. Defaults to anyone for an internet-facing gateway, and
   * to the VPC's own range for an internal one.
   */
  readonly ingress?: ReadonlyArray<GatewayIngress>;
  /**
   * Serve HTTPS on port 443 for this domain, with an ACM certificate. When
   * omitted, the gateway serves plain HTTP on port 80.
   */
  readonly domain?: string | GatewayDomain;
  /**
   * The HTTPS listener's security policy.
   * @default "ELBSecurityPolicy-TLS13-1-2-2021-06"
   */
  readonly sslPolicy?: string;
}

/** An Application Load Balancer in front of a pool's gateway. */
export interface LoadBalancerGateway extends LoadBalancerGatewayOptions {
  readonly kind: "LoadBalancer";
}

/**
 * Serve a pool's gateway from an Application Load Balancer. Calls may stay
 * open for up to an hour, the load balancer's idle timeout.
 *
 * ### Choosing a load balancer gateway
 * **Example:** HTTPS on your domain
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.LoadBalancerGateway({ domain: "cluster.example.com" }),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * **Example:** Only callers inside the VPC
 * ```typescript
 * export const Default = ClusterAWS.EcsPool("Default", {
 *   gateway: ClusterAWS.LoadBalancerGateway({ scheme: "internal" }),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const LoadBalancerGateway = (
  options: LoadBalancerGatewayOptions = {},
): LoadBalancerGateway => ({ ...options, kind: "LoadBalancer" });
