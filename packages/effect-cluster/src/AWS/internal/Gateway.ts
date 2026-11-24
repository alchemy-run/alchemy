/**
 * What the AWS runners share: the database's VPC, and the front door that
 * serves each pool's gateway to its callers: a load balancer, or CloudFront
 * in front of an internal one.
 *
 * @internal
 */
import * as CloudFront from "@alchemy.run/aws/CloudFront";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
} from "@alchemy.run/aws/CloudFront/ManagedPolicies";
import { domainCertificate, isRoute53Dns, resolveDomainDns } from "@alchemy.run/aws/CustomDomain";
import * as EC2 from "@alchemy.run/aws/EC2";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { findPublicHostedZoneId } from "@alchemy.run/aws/Route53/HostedZoneLookup";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ClusterNetwork, DatabaseShape } from "../../Database.ts";
import { GATEWAY_PORT } from "../../internal/Gateway.ts";
import type { CloudFrontGateway } from "../CloudFrontGateway.ts";
import type { Gateway } from "../Gateway.ts";
import type { GatewayDomain, GatewayIngress, LoadBalancerGateway } from "../LoadBalancerGateway.ts";

export type AwsNetwork = Extract<ClusterNetwork, { kind: "aws" }>;

export const awsNetworkOf = (database: DatabaseShape): AwsNetwork | undefined =>
  database.network?.kind === "aws" ? database.network : undefined;

/** A gateway's domain has no public Route 53 hosted zone. */
export class GatewayHostedZoneNotFound extends Data.TaggedError("GatewayHostedZoneNotFound")<{
  readonly domainName: string;
  readonly message: string;
}> {}

/** Every method a gateway call may use: RPCs are POSTs, `/health` a GET. */
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"] as const;

interface BalancerOptions {
  readonly scheme: "internet-facing" | "internal";
  readonly ingress: ReadonlyArray<GatewayIngress>;
  readonly port: number;
  readonly https?: { readonly certificateArn: Input<string>; readonly sslPolicy: string };
}

/**
 * A load balancer in front of the pool's gateway, on `port`, admitting
 * `ingress`. Runners take gateway traffic only from it.
 */
const makeBalancer = Effect.fn(function* (
  id: string,
  network: AwsNetwork,
  targetType: "ip" | "instance",
  options: BalancerOptions,
) {
  // The database's network, as the EC2 identifiers it holds.
  const vpcId = network.vpcId as Input<EC2.VpcId>;
  const subnetIds = network.subnetIds as Input<EC2.SubnetId>[];
  const { port } = options;
  const balancerGroup = yield* EC2.SecurityGroup(`${id}GatewayBalancerGroup`, {
    vpcId,
    description: "Effect Cluster gateway load balancer",
    ingress: options.ingress.map((source) => ({
      ipProtocol: "tcp",
      fromPort: port,
      toPort: port,
      ...("cidrIpv4" in source
        ? { cidrIpv4: source.cidrIpv4 }
        : "prefixListId" in source
          ? { prefixListId: source.prefixListId as string }
          : { referencedGroupId: source.securityGroupId as EC2.SecurityGroupId }),
    })),
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const gatewayGroup = yield* EC2.SecurityGroup(`${id}GatewayGroup`, {
    vpcId,
    description: "Effect Cluster gateway",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: GATEWAY_PORT,
        toPort: GATEWAY_PORT,
        referencedGroupId: balancerGroup.groupId,
      },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const targets = yield* ELBv2.TargetGroup(`${id}Gateway`, {
    vpcId,
    port: GATEWAY_PORT,
    protocol: "HTTP",
    targetType,
    healthCheckPath: "/health",
    matcher: { HttpCode: "200" },
  });
  const balancer = yield* ELBv2.LoadBalancer(`${id}GatewayBalancer`, {
    type: "application",
    scheme: options.scheme,
    subnets: subnetIds,
    securityGroups: [balancerGroup.groupId],
    // Calls wait on entities and streams stay open.
    attributes: { "idle_timeout.timeout_seconds": "3600" },
  });
  const listener = yield* ELBv2.Listener(`${id}GatewayListener`, {
    loadBalancerArn: balancer.loadBalancerArn,
    port,
    protocol: options.https ? "HTTPS" : "HTTP",
    ...(options.https
      ? {
          certificateArn: options.https.certificateArn as string,
          sslPolicy: options.https.sslPolicy,
        }
      : {}),
    targetGroupArn: targets.targetGroupArn,
  });
  return { balancer, listener, targets, gatewayGroup };
});

const domainOf = (domain: string | GatewayDomain | undefined): GatewayDomain | undefined =>
  typeof domain === "string" ? { name: domain } : domain;

const makeLoadBalancerGateway = Effect.fn(function* (
  id: string,
  network: AwsNetwork,
  targetType: "ip" | "instance",
  gateway: LoadBalancerGateway,
) {
  const scheme = gateway.scheme ?? "internet-facing";
  const ingress =
    gateway.ingress ??
    (scheme === "internal"
      ? [{ cidrIpv4: network.cidrBlock as unknown as string }]
      : [{ cidrIpv4: "0.0.0.0/0" }]);
  const domain = domainOf(gateway.domain);
  if (domain === undefined) {
    const { balancer, listener, targets, gatewayGroup } = yield* makeBalancer(
      id,
      network,
      targetType,
      { scheme, ingress, port: 80 },
    );
    return {
      // Ordered after the listener, so callers use it once it serves.
      url: Output.all(balancer.dnsName, listener.listenerArn).pipe(
        Output.map(([dns]) => `http://${dns}`),
      ),
      targetGroupArn: targets.targetGroupArn,
      securityGroupId: gatewayGroup.groupId,
    };
  }
  const names = [domain.name, ...(domain.aliases ?? [])];
  // Route 53 (the default) needs each name's hosted zone up front; other DNS
  // hosts find their zone while deploying.
  const route53 = isRoute53Dns(domain.dns);
  const pinnedZone = domain.dns?.zone as string | undefined;
  const zones = new Map<string, string>();
  for (const name of route53 ? names : []) {
    const zone = pinnedZone ?? (yield* findPublicHostedZoneId(name));
    if (zone === undefined) {
      return yield* new GatewayHostedZoneNotFound({
        domainName: name,
        message: `The gateway of pool "${id}": no public Route 53 hosted zone contains '${name}'. Create the hosted zone, or pass the domain's \`dns\`.`,
      });
    }
    zones.set(name, zone);
  }
  const certificateArn =
    domain.cert ??
    (yield* domainCertificate(
      `${id}GatewayCertificate`,
      {
        domainName: domain.name,
        subjectAlternativeNames: domain.aliases,
        ...(route53 ? { hostedZoneId: zones.get(domain.name)! } : {}),
        // A load balancer listener takes a certificate in its own region.
        region: (yield* AWSEnvironment.current).region,
      },
      domain.dns,
    )).certificateArn;
  const { balancer, listener, targets, gatewayGroup } = yield* makeBalancer(
    id,
    network,
    targetType,
    {
      scheme,
      ingress,
      port: 443,
      https: {
        certificateArn,
        sslPolicy: gateway.sslPolicy ?? "ELBSecurityPolicy-TLS13-1-2-2021-06",
      },
    },
  );
  const records: Output.Output<unknown>[] = [];
  for (const name of names) {
    const dns = yield* resolveDomainDns(route53 ? undefined : domain.dns, zones.get(name));
    const record = yield* dns.alias(
      `${id}GatewayDomain-${name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`,
      {
        name,
        ipv6: false,
        target: {
          hostname: balancer.dnsName,
          route53Alias: {
            hostedZoneId: balancer.canonicalHostedZoneId,
            evaluateTargetHealth: false,
          },
        },
      },
    );
    if (Output.isOutput(record)) records.push(record);
  }
  return {
    // Ordered after the listener and the domain's records.
    url: Output.all(listener.listenerArn, ...records).pipe(
      Output.map(() => `https://${domain.name}`),
    ),
    targetGroupArn: targets.targetGroupArn,
    securityGroupId: gatewayGroup.groupId,
  };
});

const makeCloudFrontGateway = Effect.fn(function* (
  id: string,
  network: AwsNetwork,
  targetType: "ip" | "instance",
  gateway: CloudFrontGateway,
) {
  // CloudFront reaches the load balancer from network interfaces it places
  // in the VPC, so the VPC's range is the only ingress it needs.
  const { balancer, listener, targets, gatewayGroup } = yield* makeBalancer(
    id,
    network,
    targetType,
    {
      scheme: "internal",
      ingress: [{ cidrIpv4: network.cidrBlock as unknown as string }],
      port: 80,
    },
  );
  const origin = yield* CloudFront.VpcOrigin(`${id}GatewayOrigin`, {
    arn: balancer.loadBalancerArn,
    httpPort: 80,
    httpsPort: 443,
    originProtocolPolicy: "http-only",
  });
  const distribution = yield* CloudFront.Distribution(`${id}GatewayDistribution`, {
    comment: `Effect Cluster gateway of pool ${id}`,
    priceClass: gateway.priceClass,
    origins: [
      {
        id: "gateway",
        domainName: balancer.dnsName,
        vpcOriginConfig: {
          vpcOriginId: origin.vpcOriginId,
          originReadTimeout: gateway.originReadTimeout ?? "60 seconds",
          originKeepaliveTimeout: gateway.originKeepaliveTimeout ?? "60 seconds",
        },
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "gateway",
      viewerProtocolPolicy: "https-only",
      allowedMethods: [...ALL_METHODS],
      cachedMethods: ["GET", "HEAD"],
      compress: false,
      // Nothing is cached, and every header but `Host` reaches the gateway
      // (CloudFront always forwards `Authorization` on a POST).
      cachePolicyId: MANAGED_CACHING_DISABLED_POLICY_ID,
      originRequestPolicyId: MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
    },
  });
  return {
    // Ordered after the listener and the distribution.
    url: Output.all(listener.listenerArn, distribution.domainName).pipe(
      Output.map(([, domainName]) => `https://${domainName}`),
    ),
    targetGroupArn: targets.targetGroupArn,
    securityGroupId: gatewayGroup.groupId,
  };
});

/**
 * The pool's gateway. It is declared before the pool, so the gateway's URL
 * never depends on it.
 */
export const makeAwsGateway = (
  id: string,
  network: AwsNetwork,
  targetType: "ip" | "instance",
  gateway: Gateway = { kind: "LoadBalancer" },
) =>
  gateway.kind === "CloudFront"
    ? makeCloudFrontGateway(id, network, targetType, gateway)
    : // A domain without a hosted zone fails the deploy.
      makeLoadBalancerGateway(id, network, targetType, gateway).pipe(Effect.orDie);
