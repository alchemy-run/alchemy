/**
 * The `aws-ecs` Celld {@link FleetHost}: fleet nodes run as an ECS Fargate
 * service, coordinated through an S3 bucket.
 *
 * The slim topology keeps the standing cost to the Fargate tasks alone:
 *
 * - **S3 bucket** — celld's coordination + state plane; task role granted RW.
 * - **Network** — a dedicated VPC with public subnets and an S3 gateway
 *   endpoint; tasks get a public IP for egress (image pull, logs) while the
 *   security group only admits fleet traffic from inside the VPC. No NAT,
 *   no load balancer. Bring your own network via the host's `vpc` option.
 * - **Discovery** — a Cloud Map private DNS namespace; the fleet URL is
 *   `http://fleet.{namespace}:8080`, resolving to the node IPs. Any node
 *   serves any cell (celld forwards to the owner over its signed peer
 *   tunnel).
 * - **Nodes** — the pinned celld container image with a busybox-based
 *   entrypoint that resolves the task's private IP from ECS container
 *   metadata for `--advertise`.
 *
 * celld nodes load a deployment at startup, so `restartNodes` rolls the
 * service (`forceNewDeployment`) after each new version — ECS keeps old
 * tasks serving until replacements are healthy.
 */
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ACM from "../AWS/ACM/index.ts";
import * as ApplicationAutoScaling from "../AWS/ApplicationAutoScaling/index.ts";
import * as CloudMap from "../AWS/CloudMap/index.ts";
import * as EC2 from "../AWS/EC2/index.ts";
import * as ECS from "../AWS/ECS/index.ts";
import * as ELBv2 from "../AWS/ELBv2/index.ts";
import * as IAM from "../AWS/IAM/index.ts";
import * as S3 from "../AWS/S3/index.ts";
import type { Input } from "../Input.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Random } from "../Random.ts";
import { Stack } from "../Stack.ts";
import { DEFAULT_CELLD_IMAGE, DEFAULT_CELLD_VERSION } from "./CelldCli.ts";
import { FLEET_DEPLOYMENT_PATH } from "./FleetGateway.ts";
import {
  FleetHost,
  type FleetHostComposeOptions,
  type FleetHostService,
  type FleetIngressOptions,
  type FleetIngressResult,
} from "./FleetHost.ts";

declare module "./FleetHost.ts" {
  interface FleetHostOptionsRegistry {
    "aws-ecs": {
      /**
       * Bring your own network: subnets the fleet tasks (and VPC-attached
       * callers) run in, plus the security group(s) admitting fleet
       * traffic on port 8080. When omitted a dedicated VPC is composed.
       */
      vpc?: {
        vpcId: string;
        subnetIds: string[];
        securityGroupIds: string[];
      };
      /** Fargate task CPU units. @default 512 */
      cpu?: number;
      /** Fargate task memory (MiB). @default 1024 */
      memory?: number;
    };
  }
}

const FLEET_PORT = 8080;
const FLEET_CIDR = "10.61.0.0/16";

/**
 * Plan-process registry of composed fleets, keyed by fleet logical id. The
 * worker-driven `ingress` runs AFTER its worker yielded the fleet (so
 * `compose` has populated this), and needs handles onto the fleet's
 * composed children — the node service to attach the target group to, the
 * network to place the load balancer in.
 */
interface ComposedEcsFleet {
  readonly vpcId: Input<EC2.VpcId>;
  readonly subnetIds: Input<EC2.SubnetId[]>;
  /** The fleet node SG (composed) or the first BYO SG — the "private" ingress trust anchor. */
  readonly primarySecurityGroupId: Input<EC2.SecurityGroupId>;
  readonly clusterArn: Input<string>;
  readonly clusterName: Input<string>;
  readonly serviceName: Input<string>;
  readonly containerName: Input<string>;
  readonly tags: Record<string, string> | undefined;
}
const composedFleets = new Map<string, ComposedEcsFleet>();

const composeEcsFleet = ({ id, props }: FleetHostComposeOptions) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const region = yield* yield* Region;
    const options = (props.host ?? {}) as {
      vpc?: { vpcId: string; subnetIds: string[]; securityGroupIds: string[] };
      cpu?: number;
      memory?: number;
    };
    // The registry currently publishes only `latest`, so the default is a
    // digest pin — override the node image explicitly via `props.image`.
    const image = props.image ?? DEFAULT_CELLD_IMAGE;

    const secret = yield* Random("Secret", { bytes: 32 });
    const bucket = yield* S3.Bucket("Bucket", {
      forceDestroy: true,
      tags: props.tags,
    });

    let vpcId: Input<string>;
    let subnetIds: Input<string[]>;
    let securityGroupIds: Input<string[]>;
    let primarySecurityGroupId: Input<EC2.SecurityGroupId>;
    if (options.vpc !== undefined) {
      vpcId = options.vpc.vpcId;
      subnetIds = options.vpc.subnetIds;
      securityGroupIds = options.vpc.securityGroupIds;
      primarySecurityGroupId = options.vpc
        .securityGroupIds[0] as EC2.SecurityGroupId;
    } else {
      const network = yield* EC2.Network("Network", {
        cidrBlock: FLEET_CIDR,
        availabilityZones: 2,
        nat: "none",
        gatewayEndpoints: ["s3"],
        tags: props.tags,
      });
      vpcId = network.vpcId;
      subnetIds = network.publicSubnetIds;
      const securityGroup = yield* EC2.SecurityGroup("SecurityGroup", {
        vpcId: network.vpcId,
        description: `Celld fleet ${id} nodes and VPC-attached callers`,
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: FLEET_PORT,
            toPort: FLEET_PORT,
            cidrIpv4: FLEET_CIDR,
            description: "fleet gateway + peer tunnel (VPC-internal)",
          },
        ],
        tags: props.tags,
      });
      securityGroupIds = [securityGroup.groupId];
      primarySecurityGroupId = securityGroup.groupId;
    }

    const policy = yield* IAM.Policy("BucketAccess", {
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:ListBucket", "s3:GetBucketLocation"],
            Resource: [bucket.bucketArn],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      },
      tags: props.tags,
    });

    const dnsNamespace = yield* CloudMap.PrivateDnsNamespace("Discovery", {
      name: `${stack.stage}-${id}.celld.internal`.toLowerCase(),
      vpc: vpcId,
      tags: props.tags,
    });
    const discovery = yield* CloudMap.Service("FleetRecord", {
      name: "fleet",
      namespaceId: dnsNamespace.namespaceId,
      dnsRecords: [{ type: "A", ttl: "10 seconds" }],
      healthCheckCustomConfig: { failureThreshold: 1 },
      tags: props.tags,
    });

    const cluster = yield* ECS.Cluster("Cluster", { tags: props.tags });

    // Busybox-based entrypoint: no assumptions about a shell or tools in the
    // celld image; the task's private IP for `--advertise` comes from the
    // ECS container metadata endpoint.
    const dockerfile = `
FROM busybox:stable-musl AS tools
FROM ${image}
COPY --from=tools /bin/busybox /alchemy/busybox
COPY <<'ENTRYPOINT_EOF' /alchemy/entrypoint.sh
set -e
META="$(/alchemy/busybox wget -qO- "$ECS_CONTAINER_METADATA_URI_V4")"
IP="$(printf '%s' "$META" | /alchemy/busybox sed -n 's/.*"IPv4Addresses":\\["\\([0-9.]*\\)".*/\\1/p' | /alchemy/busybox head -n1)"
if [ -z "$IP" ]; then
  echo "failed to resolve task IP from ECS metadata" >&2
  exit 1
fi
# celld v0.1.0's write-replication (ltx) client resolves credentials via EC2
# IMDS only, which does not exist on Fargate — resolve the task role's
# credentials from the ECS container endpoint and export them as standard
# env vars instead. The supervision loop below bounds each celld run to 3h
# so the exported credentials are refreshed well inside their validity.
export AWS_EC2_METADATA_DISABLED=true
# Supervise celld: nodes exit when the bucket has no deployment yet (the
# first \`celld deploy\` happens AFTER the service is up), so keep the task
# alive and retry until one appears.
while true; do
  CREDS="$(/alchemy/busybox wget -qO- "http://169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")"
  export AWS_ACCESS_KEY_ID="$(printf '%s' "$CREDS" | /alchemy/busybox sed -n 's/.*"AccessKeyId":"\\([^"]*\\)".*/\\1/p')"
  export AWS_SECRET_ACCESS_KEY="$(printf '%s' "$CREDS" | /alchemy/busybox sed -n 's/.*"SecretAccessKey":"\\([^"]*\\)".*/\\1/p')"
  export AWS_SESSION_TOKEN="$(printf '%s' "$CREDS" | /alchemy/busybox sed -n 's/.*"Token":"\\([^"]*\\)".*/\\1/p')"
  /alchemy/busybox timeout -s TERM 10800 celld --bucket "$CELLD_BUCKET" --listen "0.0.0.0:${FLEET_PORT}" --advertise "$IP:${FLEET_PORT}" || true
  echo "celld exited; restarting in 5s" >&2
  /alchemy/busybox sleep 5
done
ENTRYPOINT_EOF
ENTRYPOINT ["/alchemy/busybox", "sh", "/alchemy/entrypoint.sh"]
`;

    // `instances` is either a fixed node count or an autoscaling range —
    // the object form composes an Application Auto Scaling target plus a
    // CPU target-tracking policy through the service's own `scaling` prop.
    const instances = props.instances ?? 2;
    const scaling =
      typeof instances === "object"
        ? {
            min: instances.min,
            max: instances.max,
            cpuUtilization: instances.targetCpu ?? 60,
          }
        : undefined;

    const service = yield* ECS.Service("Nodes", {
      cluster,
      dockerfile: { content: dockerfile },
      port: FLEET_PORT,
      desiredCount: typeof instances === "number" ? instances : undefined,
      scaling,
      cpu: options.cpu ?? 512,
      memory: options.memory ?? 1024,
      runtimePlatform: {
        cpuArchitecture: process.arch === "arm64" ? "ARM64" : "X86_64",
        operatingSystemFamily: "LINUX",
      },
      vpcId,
      subnets: subnetIds,
      securityGroups: securityGroupIds,
      // Egress-only public IP (image pull, CloudWatch logs) — the security
      // group admits nothing from outside the VPC.
      assignPublicIp: true,
      env: {
        CELLD_BUCKET: Output.interpolate`s3://${bucket.bucketName}`,
        AWS_REGION: region,
      },
      taskRoleManagedPolicyArns: [policy.policyArn],
      serviceRegistries: [
        { registryArn: discovery.serviceArn as unknown as string },
      ],
      tags: props.tags,
    });

    // Hand the ingress seam its handles onto the composed children (see
    // ComposedEcsFleet above).
    composedFleets.set(id, {
      vpcId: vpcId as Input<EC2.VpcId>,
      subnetIds: subnetIds as Input<EC2.SubnetId[]>,
      primarySecurityGroupId,
      clusterArn: cluster.clusterArn,
      clusterName: cluster.clusterName,
      serviceName: service.serviceName,
      containerName: service.containerName.pipe(
        Output.map((name: string | undefined) => name ?? "main"),
      ),
      tags: props.tags,
    });

    return {
      bucket: {
        uri: Output.interpolate`s3://${bucket.bucketName}`,
        region,
      },
      fleetUrl: Output.interpolate`http://${discovery.serviceName}.${dnsNamespace.namespaceName}:${String(FLEET_PORT)}`,
      fleetSecret: secret.text,
      hostState: {
        subnetIds,
        securityGroupIds,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
      },
    };
  }).pipe(Namespace.push(id));

/**
 * The `aws-ecs` fleet ingress: an ALB in front of the fleet's node tasks.
 *
 * - **ALB** — internet-facing for `expose: "public"`, internal otherwise,
 *   in the fleet's subnets. Its own security group admits 80 (and 443 with
 *   a `domain`) from the internet (public) or from the fleet's node
 *   security group (private). Nodes need no new rules: the composed node
 *   SG already admits the fleet port from the VPC CIDR, which covers the
 *   ALB's ENIs (BYO networks must admit the fleet port from their VPC).
 * - **Target group** — the nodes' gateway port, health-checked on the
 *   gateway's cheap deployment probe.
 * - **Attachment** — the target group attaches to the EXISTING node
 *   service via `AWS.ECS.ServiceTargetGroupAttachment`, whose convergence
 *   wait rides out the first `celld deploy` landing in parallel.
 * - **TLS** — with a `domain`, a DNS-validated ACM certificate is
 *   requested in-region and attached to a 443 listener; the validation
 *   record itself is declared by the worker through the `Dns` seam, and
 *   the listener provider waits out issuance.
 */
const composeEcsFleetIngress = (
  options: FleetIngressOptions,
): Effect.Effect<FleetIngressResult, any, any> =>
  Effect.gen(function* () {
    const composed = composedFleets.get(options.fleetId);
    if (composed === undefined) {
      return yield* Effect.die(
        new Error(
          `Celld fleet '${options.fleetId}' has not been composed in this ` +
            "plan — a worker's ingress resolves after its fleet; was the " +
            "fleet's host kind changed mid-plan?",
        ),
      );
    }
    const region = yield* yield* Region;
    const tags = composed.tags;
    const wantsTls = options.domain !== undefined;

    const port80 = {
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      description: "ingress HTTP",
    };
    const port443 = {
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "ingress HTTPS",
    };
    const albSecurityGroup = yield* EC2.SecurityGroup("IngressSecurityGroup", {
      vpcId: composed.vpcId,
      description: `Celld fleet ${options.fleetId} ingress`,
      ingress:
        options.expose === "public"
          ? [
              { ...port80, cidrIpv4: "0.0.0.0/0" },
              ...(wantsTls ? [{ ...port443, cidrIpv4: "0.0.0.0/0" }] : []),
            ]
          : [
              {
                ...port80,
                referencedGroupId: composed.primarySecurityGroupId,
              },
              ...(wantsTls
                ? [
                    {
                      ...port443,
                      referencedGroupId: composed.primarySecurityGroupId,
                    },
                  ]
                : []),
            ],
      tags,
    });

    const targetGroup = yield* ELBv2.TargetGroup("IngressTargets", {
      vpcId: composed.vpcId,
      port: FLEET_PORT,
      protocol: "HTTP",
      targetType: "ip",
      healthCheckPath: FLEET_DEPLOYMENT_PATH,
      healthCheckInterval: "10 seconds",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      tags,
    });

    const loadBalancer = yield* ELBv2.LoadBalancer("Ingress", {
      type: "application",
      scheme: options.expose === "public" ? "internet-facing" : "internal",
      subnets: composed.subnetIds,
      securityGroups: [albSecurityGroup.groupId],
      tags,
    });

    const httpListener = yield* ELBv2.Listener("IngressHttp", {
      loadBalancerArn: loadBalancer.loadBalancerArn,
      targetGroupArn: targetGroup.targetGroupArn,
      port: 80,
      protocol: "HTTP",
    });

    let certificate: FleetIngressResult["certificate"];
    if (options.domain !== undefined) {
      // An ALB listener needs an in-region certificate. NO hostedZoneId:
      // the validation record is declared by the caller through the Dns
      // seam, and the HTTPS listener's provider waits out issuance.
      const requested = yield* ACM.Certificate("IngressCertificate", {
        domainName: options.domain,
        region,
        tags,
      });
      certificate = {
        arn: requested.certificateArn,
        validationRecordName: requested.domainValidationOptions.pipe(
          Output.map(
            (validations: { ResourceRecord?: { Name?: string } }[]) =>
              validations[0]?.ResourceRecord?.Name ?? "",
          ),
        ),
        validationRecordValue: requested.domainValidationOptions.pipe(
          Output.map(
            (validations: { ResourceRecord?: { Value?: string } }[]) =>
              validations[0]?.ResourceRecord?.Value ?? "",
          ),
        ),
      };
      yield* ELBv2.Listener("IngressHttps", {
        loadBalancerArn: loadBalancer.loadBalancerArn,
        targetGroupArn: targetGroup.targetGroupArn,
        port: 443,
        protocol: "HTTPS",
        certificateArn: requested.certificateArn,
      });
    }

    // Attach the target group to the node service. The target group must
    // be associated with the load balancer before ECS accepts it, so the
    // attachment's ARN input is gated on the listener as well.
    yield* ECS.ServiceTargetGroupAttachment("IngressAttachment", {
      cluster: composed.clusterArn,
      serviceName: composed.serviceName,
      targetGroupArn: Output.all(
        Output.asOutput(targetGroup.targetGroupArn),
        Output.asOutput(httpListener.listenerArn),
      ).pipe(
        Output.map(([targetGroupArn]: [string, string]) => targetGroupArn),
      ),
      containerName: composed.containerName,
      containerPort: FLEET_PORT,
    });

    // Optional ingress-level autoscaling on the node service — the fleet's
    // own `instances: { min, max }` is the primary surface; don't combine
    // both.
    if (options.scaling !== undefined) {
      const scalableTarget = yield* ApplicationAutoScaling.ScalableTarget(
        "IngressScalingTarget",
        {
          serviceNamespace: "ecs",
          resourceId: Output.interpolate`service/${composed.clusterName}/${composed.serviceName}`,
          scalableDimension: "ecs:service:DesiredCount",
          minCapacity: options.scaling.min,
          maxCapacity: options.scaling.max,
        },
      );
      yield* ApplicationAutoScaling.ScalingPolicy("IngressScalingPolicy", {
        serviceNamespace: "ecs",
        resourceId: scalableTarget.resourceId,
        scalableDimension: "ecs:service:DesiredCount",
        targetTracking: {
          TargetValue: options.scaling.targetCpu ?? 60,
          PredefinedMetricSpecification: {
            PredefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
        },
      });
    }

    return {
      url:
        options.domain !== undefined
          ? `https://${options.domain}`
          : Output.interpolate`http://${loadBalancer.dnsName}`,
      dnsName: loadBalancer.dnsName,
      certificate,
    } satisfies FleetIngressResult;
  });

/**
 * The `aws-ecs` {@link FleetHost} layer. Registered by `AWS.providers()`;
 * compose a stack with `Layer.mergeAll(AWS.providers(), Celld.providers())`
 * and the host resolves automatically.
 */
export const EcsFleetHost = (): Layer.Layer<FleetHost<"aws-ecs">> =>
  Layer.effect(
    FleetHost("aws-ecs"),
    Effect.gen(function* () {
      // Captured at layer build (inside `AWS.providers()`'s composition) so
      // `deployEnv`/`restartNodes` work from the host-agnostic Celld
      // provider context, which carries no AWS services.
      const credentials = yield* Credentials;
      const region = yield* Region;
      const updateService = yield* ecs.updateService;

      return {
        kind: "Celld.FleetHost" as const,

        compose: composeEcsFleet,

        ingress: composeEcsFleetIngress,

        deployEnv: () =>
          Effect.gen(function* () {
            // celld only supports the standard credential chain — resolve
            // the deployer's credentials (SSO included) to static values.
            const resolved = yield* credentials;
            return {
              AWS_ACCESS_KEY_ID: Redacted.value(resolved.accessKeyId),
              AWS_SECRET_ACCESS_KEY: Redacted.value(resolved.secretAccessKey),
              ...(resolved.sessionToken !== undefined
                ? { AWS_SESSION_TOKEN: Redacted.value(resolved.sessionToken) }
                : {}),
              AWS_REGION: yield* region,
              // The managed CLI cache lives under $HOME/.alchemy.
              ...Option.match(
                yield* Config.option(Config.string("HOME")).pipe(
                  Effect.orElseSucceed(() => Option.none<string>()),
                ),
                {
                  onNone: () => ({}),
                  onSome: (home) => ({ HOME: home }),
                },
              ),
            };
          }),

        restartNodes: ({ news }) =>
          Effect.gen(function* () {
            const state = news.hostState as
              | { clusterArn?: string; serviceName?: string }
              | undefined;
            if (
              state?.clusterArn === undefined ||
              state.serviceName === undefined
            ) {
              return;
            }
            // Roll the nodes so they load the new deployment. ECS keeps old
            // tasks serving until replacements are healthy; readiness for
            // the *new* version is observed by callers via the gateway's
            // deployment probe.
            yield* updateService({
              cluster: state.clusterArn,
              service: state.serviceName,
              forceNewDeployment: true,
            });
          }),
      } satisfies FleetHostService;
    }),
  ) as Layer.Layer<FleetHost<"aws-ecs">>;

export { DEFAULT_CELLD_VERSION };
