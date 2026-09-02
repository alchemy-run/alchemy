import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { AwsAuth } from "../AWS/AuthProvider.ts";
import * as CloudMap from "../AWS/CloudMap/index.ts";
import * as AwsCredentials from "../AWS/Credentials.ts";
import * as EC2 from "../AWS/EC2/index.ts";
import * as ECS from "../AWS/ECS/index.ts";
import * as Endpoint from "../AWS/Endpoint.ts";
import { Default as DefaultEnvironment } from "../AWS/Environment.ts";
import * as IAM from "../AWS/IAM/index.ts";
import * as AwsRegion from "../AWS/Region.ts";
import * as S3 from "../AWS/S3/index.ts";
import type { Input } from "../Input.ts";
import * as Namespace from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Stack, type StackServices } from "../Stack.ts";
import { DEFAULT_CELLD_IMAGE } from "./CelldCli.ts";
import { Host, type HostService } from "./Host.ts";
import { FLEET_DEPLOYMENT_PATH } from "./WorkerBridge.ts";

const FLEET_PORT = 8080;
const FLEET_CIDR = "10.61.0.0/16";

/**
 * What the ECS host persists on the Fleet's `hostState`: the handles a
 * worker's ingress and a caller's network attachment need.
 */
interface EcsHostState {
  readonly vpcId: EC2.VpcId;
  readonly subnetIds: EC2.SubnetId[];
  readonly securityGroupIds: EC2.SecurityGroupId[];
  readonly clusterArn: string;
  readonly serviceName: string;
  readonly containerName: string;
}

/**
 * Compose the fleet on ECS Fargate. The slim topology keeps the standing
 * cost to the Fargate tasks alone:
 *
 * - **S3 bucket** — celld's coordination + state plane; task role granted RW.
 * - **Network** — a dedicated VPC with public subnets and an S3 gateway
 *   endpoint; tasks get a public IP for egress (image pull, logs) while the
 *   security group only admits fleet traffic from inside the VPC. No NAT,
 *   no load balancer. Bring your own network via the fleet's `vpc` prop.
 * - **Discovery** — a Cloud Map private DNS namespace; the fleet URL is
 *   `http://fleet.{namespace}:8080`, resolving to the node IPs. Any node
 *   serves any cell (celld forwards to the owner over its signed peer
 *   tunnel).
 * - **Nodes** — the pinned celld container image with a busybox-based
 *   entrypoint that resolves the task's private IP from ECS container
 *   metadata for `--advertise`.
 */
const composeEcsFleet = (
  region: Effect.Effect<string>,
): HostService["compose"] =>
  Effect.fn(
    function* ({ id, props }) {
      const stack = yield* Stack;
      const regionName = yield* region;
      // The registry currently publishes only `latest`, so the default is a
      // digest pin — override the node image explicitly via `props.image`.
      const image = props.image ?? DEFAULT_CELLD_IMAGE;

      const bucket = yield* S3.Bucket("Bucket", {
        forceDestroy: true,
        tags: props.tags,
      });

      let vpcId: Input<EC2.VpcId>;
      let subnetIds: Input<EC2.SubnetId[]>;
      let securityGroupIds: Input<EC2.SecurityGroupId[]>;
      if (props.vpc !== undefined) {
        vpcId = props.vpc.vpcId as EC2.VpcId;
        subnetIds = props.vpc.subnetIds as EC2.SubnetId[];
        securityGroupIds = props.vpc.securityGroupIds as EC2.SecurityGroupId[];
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

      // `instances` is either a fixed node count or an autoscaling range —
      // the object form composes a CPU target-tracking policy through the
      // service's own `scaling` prop.
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
        cpu: props.cpu ?? 512,
        memory: props.memory ?? 1024,
        runtimePlatform: {
          cpuArchitecture: props.cpuArchitecture ?? "ARM64",
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
          AWS_REGION: regionName,
        },
        taskRoleManagedPolicyArns: [policy.policyArn],
        serviceRegistries: [
          { registryArn: discovery.serviceArn as unknown as string },
        ],
        tags: props.tags,
      });

      const hostState: { [K in keyof EcsHostState]: Input<EcsHostState[K]> } = {
        vpcId,
        subnetIds,
        securityGroupIds,
        clusterArn: cluster.clusterArn,
        serviceName: service.serviceName,
        containerName: service.containerName.pipe(
          Output.map((name: string | undefined) => name ?? "main"),
        ),
      };

      return {
        bucket: {
          uri: Output.interpolate`s3://${bucket.bucketName}`,
          region: regionName,
        },
        fleetUrl: Output.interpolate`http://${discovery.serviceName}.${dnsNamespace.namespaceName}:${String(FLEET_PORT)}`,
        hostState,
      };
    },
    (effect, { id }) => effect.pipe(Namespace.push(id)),
  );

/**
 * Public ingress in front of the fleet's node tasks — `AWS.ECS.ServiceIngress`
 * over the EXISTING node service, health-checked on the gateway's cheap
 * deployment probe. Nodes need no new rules: the composed node security
 * group already admits the fleet port from the VPC CIDR, which covers the
 * load balancer's ENIs (a BYO network must admit the fleet port from its
 * VPC). DNS is left to the worker, which publishes the records through the
 * `Alchemy.Dns` seam.
 */
const composeEcsFleetIngress: HostService["ingress"] = Effect.fn(function* ({
  fleet,
  domain,
}) {
  // A composed fleet always carries the ECS host state (see `compose`);
  // read its handles off the attribute Output.
  const state = fleet.hostState as unknown as Output.Output<EcsHostState>;
  const field = <K extends keyof EcsHostState>(key: K) =>
    state.pipe(Output.map((s: EcsHostState) => s[key]));
  const ingress = yield* ECS.ServiceIngress("Ingress", {
    network: { vpcId: field("vpcId"), subnetIds: field("subnetIds") },
    service: {
      clusterArn: field("clusterArn"),
      serviceName: field("serviceName"),
      containerName: field("containerName"),
    },
    port: FLEET_PORT,
    healthCheck: { path: FLEET_DEPLOYMENT_PATH },
    domain,
    tags: fleet.Props?.tags,
  });
  return {
    url: ingress.url,
    dnsName: ingress.dnsName,
    validationRecords: ingress.validationRecords,
  };
});

/** The AWS environment the host's imperative calls run against. */
const awsEnvironment = Layer.mergeAll(
  AwsRegion.fromEnvironment,
  AwsCredentials.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);

/**
 * The AWS ECS implementation of `Celld.Host`: fleet nodes run as an ECS
 * Fargate service coordinated through an S3 bucket, discovered through a
 * Cloud Map private DNS namespace, and exposed (when a `Celld.Worker` asks)
 * through `AWS.ECS.ServiceIngress`.
 *
 * ### Composing the Host
 * **Example:** A stack running celld fleets on Fargate
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Celld from "alchemy/Celld";
 * import * as Layer from "effect/Layer";
 *
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 *
 * @layer
 * @provides Celld.Host
 * @product Celld
 */
export const Ecs = (): Layer.Layer<Host, never, StackServices> =>
  Layer.effect(
    Host,
    Effect.gen(function* () {
      // Captured at layer build so `deployEnv`/`restartNodes` work from the
      // host-agnostic Celld provider context, which carries no AWS services.
      const credentials = yield* Credentials;
      const region = yield* Region;
      const updateService = yield* ecs.updateService;

      return {
        compose: composeEcsFleet(region),

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
            const state = news.hostState as Partial<EcsHostState> | undefined;
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
      } satisfies HostService;
    }),
  ).pipe(Layer.provide(awsEnvironment), Layer.orDie);
