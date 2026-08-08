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
import * as ecs from "@distilled.cloud/aws/ecs";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  FleetHost,
  type FleetHostComposeOptions,
  type FleetHostService,
} from "../../Celld/FleetHost.ts";
import {
  DEFAULT_CELLD_IMAGE,
  DEFAULT_CELLD_VERSION,
} from "../../Celld/CelldCli.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Random } from "../../Random.ts";
import { Stack } from "../../Stack.ts";
import * as CloudMap from "../CloudMap/index.ts";
import * as EC2 from "../EC2/index.ts";
import * as ECS from "../ECS/index.ts";
import * as IAM from "../IAM/index.ts";
import * as S3 from "../S3/index.ts";

declare module "../../Celld/FleetHost.ts" {
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
    if (options.vpc !== undefined) {
      vpcId = options.vpc.vpcId;
      subnetIds = options.vpc.subnetIds;
      securityGroupIds = options.vpc.securityGroupIds;
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

    const service = yield* ECS.Service("Nodes", {
      cluster,
      dockerfile: { content: dockerfile },
      port: FLEET_PORT,
      desiredCount: props.instances ?? 2,
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

        callerBinding: ({ target }) =>
          Effect.succeed({
            vpc: {
              subnetIds: target.hostState.pipe(
                Output.map((state: any) => state?.subnetIds ?? []),
              ),
              securityGroupIds: target.hostState.pipe(
                Output.map((state: any) => state?.securityGroupIds ?? []),
              ),
            },
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
