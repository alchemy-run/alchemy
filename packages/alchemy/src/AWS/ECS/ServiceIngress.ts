import { Region } from "@distilled.cloud/aws/Region";
import type * as acm from "@distilled.cloud/aws/acm";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { DnsRecordProps } from "../../Dns.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { Certificate as CertificateResource } from "../ACM/Certificate.ts";
import { Certificate } from "../ACM/Certificate.ts";
import type { CertificateValidation as CertificateValidationResource } from "../ACM/CertificateValidation.ts";
import { CertificateValidation } from "../ACM/CertificateValidation.ts";
import type {
  SecurityGroup as SecurityGroupResource,
  SecurityGroupRuleData,
} from "../EC2/SecurityGroup.ts";
import { SecurityGroup } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { VpcId } from "../EC2/Vpc.ts";
import type { Listener as ListenerResource } from "../ELBv2/Listener.ts";
import { Listener } from "../ELBv2/Listener.ts";
import type { LoadBalancer as LoadBalancerResource } from "../ELBv2/LoadBalancer.ts";
import { LoadBalancer } from "../ELBv2/LoadBalancer.ts";
import type { TargetGroup as TargetGroupResource } from "../ELBv2/TargetGroup.ts";
import { TargetGroup } from "../ELBv2/TargetGroup.ts";
import type { ServiceTargetGroupAttachment as ServiceTargetGroupAttachmentResource } from "./ServiceTargetGroupAttachment.ts";
import { ServiceTargetGroupAttachment } from "./ServiceTargetGroupAttachment.ts";

export interface ServiceIngressProps {
  /** Where the load balancer lives. */
  network: {
    /** The VPC the service's tasks run in. */
    vpcId: Input<VpcId>;
    /**
     * PUBLIC subnets (a route to an internet gateway, at least two
     * Availability Zones) for the internet-facing load balancer.
     */
    subnetIds: Input<SubnetId[]>;
  };
  /**
   * The EXISTING ECS service to expose. The service's own security group
   * must admit {@link port} from the VPC (the load balancer's ENIs live in
   * `network.subnetIds`); the composer never edits a security group it
   * does not own.
   */
  service: {
    /** ARN of the cluster running the service. */
    clusterArn: Input<string>;
    /** Name of the service. */
    serviceName: Input<string>;
    /** Name of the container receiving traffic. */
    containerName: Input<string>;
  };
  /** Container port the load balancer forwards to. */
  port: number;
  /** Target-group health check against the container. */
  healthCheck: {
    /** Request path, e.g. `/healthz`. */
    path: string;
    /**
     * Port to probe.
     * @default the traffic port
     */
    port?: number;
    /**
     * Probe interval.
     * @default "10 seconds"
     */
    interval?: Duration.Input;
    /**
     * Consecutive successes before a target is healthy.
     * @default 2
     */
    healthyThresholdCount?: number;
    /**
     * Consecutive failures before a target is unhealthy.
     * @default 2
     */
    unhealthyThresholdCount?: number;
  };
  /**
   * Custom domain. When set, a DNS-validated ACM certificate is requested
   * in the load balancer's region, an HTTPS listener serves it, and the
   * HTTP listener becomes a permanent redirect to HTTPS. The composer does
   * NOT publish DNS: declare {@link ServiceIngressResources.validationRecords}
   * and the domain's CNAME (to {@link ServiceIngressResources.dnsName})
   * through the `Alchemy.Dns` seam or your DNS provider's record resource.
   */
  domain?: string;
  /** Tags applied to every composed resource. */
  tags?: Record<string, string>;
}

/** TLS material composed when a `domain` is requested. */
export interface ServiceIngressCertificate {
  /** The requested (pending) certificate. */
  certificate: CertificateResource;
  /** The node consumers depend on — resolves once the certificate is ISSUED. */
  validation: CertificateValidationResource;
  /** ARN of the ISSUED certificate. */
  arn: CertificateValidationResource["certificateArn"];
}

export interface ServiceIngressResources {
  /**
   * The URL the service serves on: `https://{domain}` with a domain,
   * otherwise `http://{load balancer DNS name}`.
   */
  url: Input<string>;
  /** DNS name of the load balancer — the `domain` CNAME's target. */
  dnsName: LoadBalancerResource["dnsName"];
  /** The load balancer's security group (80, and 443 with a domain, from anywhere). */
  securityGroup: SecurityGroupResource;
  /** The target group the service's tasks register into. */
  targetGroup: TargetGroupResource;
  /** The internet-facing application load balancer. */
  loadBalancer: LoadBalancerResource;
  /** Port 80 — forwards to the service, or redirects to HTTPS with a domain. */
  httpListener: ListenerResource;
  /** Port 443, when a domain was requested. */
  httpsListener: ListenerResource | undefined;
  /** TLS material, when a domain was requested. */
  certificate: ServiceIngressCertificate | undefined;
  /**
   * DNS records a DNS provider must publish for the certificate to be
   * issued — one `CNAME` per validated name (a single-domain certificate
   * has exactly one). Shaped as `Alchemy.Dns` record props so a caller can
   * hand each straight to `dns.record(...)`; empty without a domain.
   */
  validationRecords: DnsRecordProps[];
  /** The target group's attachment to the service. */
  attachment: ServiceTargetGroupAttachmentResource;
}

export type ServiceIngress = Effect.Success<ReturnType<typeof ServiceIngress>>;

/**
 * Public HTTP(S) ingress for an EXISTING ECS service: an internet-facing
 * application load balancer in front of the service's tasks, composed from
 * the canonical `AWS.EC2` / `AWS.ELBv2` / `AWS.ACM` primitives — the
 * ergonomic entry point for a resource that exposes a service it did not
 * author (a fleet host, an engine host), in the same spirit as
 * `AWS.EC2.Network`.
 *
 * What it composes:
 *
 * - a security group admitting 80 (and 443 with a `domain`) from anywhere;
 * - a target group on {@link ServiceIngressProps.port}, health-checked at
 *   `healthCheck.path`;
 * - an internet-facing ALB in the public subnets and an HTTP listener;
 * - with a `domain`: an ACM certificate in the load balancer's region, an
 *   `AWS.ACM.CertificateValidation` that waits for issuance, an HTTPS
 *   listener gated on that validation, and the HTTP listener as a permanent
 *   redirect to HTTPS;
 * - an `AWS.ECS.ServiceTargetGroupAttachment` registering the service's
 *   tasks into the target group.
 *
 * DNS is deliberately NOT composed — the certificate's validation records
 * come back as {@link ServiceIngressResources.validationRecords} and the
 * load balancer's {@link ServiceIngressResources.dnsName} is the domain's
 * CNAME target, so the caller publishes both through whichever DNS provider
 * hosts the zone. Autoscaling is likewise the service owner's concern.
 *
 * ### Exposing a Service
 * **Example:** Plain HTTP on the load balancer's DNS name
 * ```typescript
 * const ingress = yield* AWS.ECS.ServiceIngress("Ingress", {
 *   network: { vpcId: network.vpcId, subnetIds: network.publicSubnetIds },
 *   service: {
 *     clusterArn: cluster.clusterArn,
 *     serviceName: service.serviceName,
 *     containerName: "app",
 *   },
 *   port: 8080,
 *   healthCheck: { path: "/healthz" },
 * });
 * // http://{alb-dns-name}
 * return { url: ingress.url };
 * ```
 *
 * ### Custom Domain
 * **Example:** HTTPS on a domain, DNS published through the `Alchemy.Dns` seam
 * ```typescript
 * const ingress = yield* AWS.ECS.ServiceIngress("Ingress", {
 *   network: { vpcId: network.vpcId, subnetIds: network.publicSubnetIds },
 *   service: {
 *     clusterArn: cluster.clusterArn,
 *     serviceName: service.serviceName,
 *     containerName: "app",
 *   },
 *   port: 8080,
 *   healthCheck: { path: "/healthz" },
 *   domain: "api.example.com",
 * });
 * const dns = yield* Alchemy.Dns; // AWS.Route53Dns() or Cloudflare.CloudflareDns()
 * yield* dns.record("Domain", {
 *   name: "api.example.com",
 *   type: "CNAME",
 *   values: [ingress.dnsName],
 * });
 * for (const [index, record] of ingress.validationRecords.entries()) {
 *   yield* dns.record(`Validation${index}`, record);
 * }
 * // https://api.example.com
 * return { url: ingress.url };
 * ```
 *
 * @resource
 */
export const ServiceIngress = (id: string, props: ServiceIngressProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const tags = props.tags;
      const wantsTls = props.domain !== undefined;

      const fromAnywhere = (
        port: number,
        description: string,
      ): SecurityGroupRuleData => ({
        ipProtocol: "tcp",
        fromPort: port,
        toPort: port,
        cidrIpv4: "0.0.0.0/0",
        description,
      });
      const securityGroup = yield* SecurityGroup("SecurityGroup", {
        vpcId: props.network.vpcId,
        description: `${id} ingress`,
        ingress: [
          fromAnywhere(80, "ingress HTTP"),
          ...(wantsTls ? [fromAnywhere(443, "ingress HTTPS")] : []),
        ],
        tags,
      });

      const targetGroup = yield* TargetGroup("TargetGroup", {
        vpcId: props.network.vpcId,
        port: props.port,
        protocol: "HTTP",
        targetType: "ip",
        healthCheckPath: props.healthCheck.path,
        healthCheckPort:
          props.healthCheck.port !== undefined
            ? String(props.healthCheck.port)
            : undefined,
        healthCheckInterval: props.healthCheck.interval ?? "10 seconds",
        healthyThresholdCount: props.healthCheck.healthyThresholdCount ?? 2,
        unhealthyThresholdCount: props.healthCheck.unhealthyThresholdCount ?? 2,
        tags,
      });

      const loadBalancer = yield* LoadBalancer("LoadBalancer", {
        type: "application",
        scheme: "internet-facing",
        subnets: props.network.subnetIds,
        securityGroups: [securityGroup.groupId],
        tags,
      });

      let certificate: ServiceIngressCertificate | undefined;
      const validationRecords: DnsRecordProps[] = [];
      let httpsListener: ListenerResource | undefined;
      if (props.domain !== undefined) {
        // An ALB listener needs an in-region certificate. NO hostedZoneId:
        // the validation record is published by the caller (any DNS
        // provider), and `CertificateValidation` waits out issuance so the
        // HTTPS listener only ever attaches an ISSUED certificate.
        const region = yield* yield* Region;
        const requested = yield* Certificate("Certificate", {
          domainName: props.domain,
          region,
          tags,
        });
        // `Certificate` returns once ACM populated the validation records,
        // and a single-domain certificate carries exactly one.
        const validationRecord = requested.domainValidationOptions.pipe(
          Output.map(
            (validations: acm.DomainValidation[]) =>
              validations[0]?.ResourceRecord,
          ),
        );
        const validationName = validationRecord.pipe(
          Output.map((record: acm.ResourceRecord | undefined) =>
            (record?.Name ?? "").replace(/\.$/, ""),
          ),
        );
        const validationValue = validationRecord.pipe(
          Output.map((record: acm.ResourceRecord | undefined) =>
            (record?.Value ?? "").replace(/\.$/, ""),
          ),
        );
        validationRecords.push({
          name: validationName,
          type: "CNAME",
          values: [validationValue],
        });
        const validation = yield* CertificateValidation("Validation", {
          certificateArn: requested.certificateArn,
          validationRecordFqdns: [validationName],
        });
        certificate = {
          certificate: requested,
          validation,
          arn: validation.certificateArn,
        };
        httpsListener = yield* Listener("Https", {
          loadBalancerArn: loadBalancer.loadBalancerArn,
          targetGroupArn: targetGroup.targetGroupArn,
          port: 443,
          protocol: "HTTPS",
          certificateArn: validation.certificateArn,
        });
      }

      const httpListener = yield* Listener("Http", {
        loadBalancerArn: loadBalancer.loadBalancerArn,
        port: 80,
        protocol: "HTTP",
        ...(wantsTls
          ? {
              // With TLS, plaintext never reaches the service.
              defaultActions: [
                {
                  type: "redirect" as const,
                  statusCode: "HTTP_301" as const,
                  protocol: "HTTPS",
                  port: "443",
                },
              ],
            }
          : { targetGroupArn: targetGroup.targetGroupArn }),
      });

      // Attach the target group to the service. ECS only accepts a target
      // group that is already associated with a load balancer — i.e. one a
      // listener FORWARDS to — so the attachment's ARN input is gated on
      // the forwarding listener (HTTPS with a domain, HTTP otherwise).
      const forwardingListener = httpsListener ?? httpListener;
      const attachment = yield* ServiceTargetGroupAttachment("Attachment", {
        cluster: props.service.clusterArn,
        serviceName: props.service.serviceName,
        targetGroupArn: Output.all(
          Output.asOutput(targetGroup.targetGroupArn),
          Output.asOutput(forwardingListener.listenerArn),
        ).pipe(
          Output.map(([targetGroupArn]: [string, string]) => targetGroupArn),
        ),
        containerName: props.service.containerName,
        containerPort: props.port,
      });

      return {
        url:
          props.domain !== undefined
            ? `https://${props.domain}`
            : Output.interpolate`http://${loadBalancer.dnsName}`,
        dnsName: loadBalancer.dnsName,
        securityGroup,
        targetGroup,
        loadBalancer,
        httpListener,
        httpsListener,
        certificate,
        validationRecords,
        attachment,
      } satisfies ServiceIngressResources;
    }),
  );
