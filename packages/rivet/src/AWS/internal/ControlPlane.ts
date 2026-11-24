/**
 * What every AWS control plane shares, whatever runs its engines: a VPC, the
 * bucket, the instances' role, security groups, an Application Load
 * Balancer, and one EC2 instance per engine with an EBS data disk of its
 * own. A host only decides how each instance boots and runs its engine.
 *
 * @internal
 */
import * as CloudFront from "@alchemy.run/aws/CloudFront";
import * as EC2 from "@alchemy.run/aws/EC2";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import * as IAM from "@alchemy.run/aws/IAM";
import * as S3 from "@alchemy.run/aws/S3";
import * as SecretsManager from "@alchemy.run/aws/SecretsManager";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../../Cluster.ts";
import { adminToken } from "../../internal/AdminToken.ts";
import { Namespace } from "../../Namespace.ts";
import { Network } from "../Network.ts";

/** The engine release AWS control planes run by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.1.1";

/** Where each instance mounts its disk, and where the engine stores its log. */
export const DATA_PATH = "/var/lib/rivet";

/** The engine API port, behind the load balancer. */
export const API_PORT = 6420;

/** The engine peer port, reachable only by other instances. */
export const PEER_PORT = 6421;

export interface ControlPlaneProps {
  /**
   * Number of control plane instances, spread across Availability Zones.
   * Run 3 or more in production: each write is replicated to several
   * instances' disks before it moves to the bucket.
   * @default 3
   */
  instances?: number;
  /**
   * EC2 instance type of each instance.
   * @default "t3.medium"
   */
  instanceType?: string;
  /**
   * Size of each instance's data disk, in GiB.
   * @default 20
   */
  diskSize?: number;
  /**
   * Engine image.
   * @default "rivetdev/engine:3.1.1"
   */
  image?: string;
  /**
   * IPv4 CIDR block of the control plane's VPC.
   * @default "10.42.0.0/16"
   */
  cidrBlock?: string;
}

/** The env var the engine reads its admin token from. */
export const ADMIN_TOKEN_ENV = "RIVET__AUTH__ADMIN_TOKEN";

/**
 * The engine's configuration, as environment variables, but for its admin
 * token ({@link ADMIN_TOKEN_ENV}), which it reads from Secrets Manager.
 */
export const engineEnvironment = (options: {
  readonly bucket: string;
  readonly region: string;
  readonly advertiseAddress: string;
}) => ({
  RIVET__STORAGE__LOG_DIRECTORY: DATA_PATH,
  RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "true",
  RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET: options.bucket,
  RIVET__OBJECT_STORAGE__PRIMARY__S3__REGION: options.region,
  RIVET__API_PEER__ADVERTISE_ADDRESS: options.advertiseAddress,
  RIVET__TELEMETRY__ENABLED: "false",
});

/** Mount the instance's data disk, which is attached after the instance starts. */
export const mountDataDisk = (volumeId: string) => `
DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace("-", "")}"
for attempt in $(seq 1 120); do
  [ -e "$DEVICE" ] && break
  sleep 5
done
[ -e "$DEVICE" ] || { echo "data disk ${volumeId} never attached" >&2; exit 1; }
blkid "$DEVICE" >/dev/null || mkfs.xfs "$DEVICE"
mkdir -p ${DATA_PATH}
mount "$DEVICE" ${DATA_PATH}
echo "$DEVICE ${DATA_PATH} xfs defaults,nofail 0 2" >> /etc/fstab
`;

/**
 * Read the admin token from Secrets Manager into {@link ADMIN_TOKEN_ENV},
 * with the instance role, retrying while the role's grant propagates.
 */
export const readAdminToken = (boot: {
  readonly tokenSecretArn: string;
  readonly region: string;
}) => `
for attempt in $(seq 1 60); do
  ${ADMIN_TOKEN_ENV}="$(aws secretsmanager get-secret-value --region ${boot.region} --secret-id '${boot.tokenSecretArn}' --query SecretString --output text 2>/dev/null)" && break
  sleep 5
done
[ -n "\${${ADMIN_TOKEN_ENV}:-}" ] || { echo "could not read the admin token" >&2; exit 1; }
export ${ADMIN_TOKEN_ENV}
`;

/** What a host knows about one instance while booting it. */
export interface EngineBoot {
  readonly index: number;
  readonly image: string;
  /** The ARN of the Secrets Manager secret holding the admin token. */
  readonly tokenSecretArn: string;
  readonly volumeId: string;
  readonly bucket: string;
  readonly region: string;
}

/** One instance, once it exists. */
export interface EngineInstance {
  readonly index: number;
  readonly instance: EC2.Instance;
}

/** How a host runs engines on the shared instances. */
export interface ControlPlaneHost<Req> {
  /** The AMI every instance boots. */
  readonly imageId: Output.Output<string>;
  /** Managed policies the instances' role needs besides bucket access. */
  readonly managedPolicyArns?: string[];
  /** Resources declared once, before the instances (e.g. an ECS cluster). */
  readonly setup?: () => Effect.Effect<Output.Output<SetupResult>, never, Req>;
  /** The instance's user data. */
  readonly userData: (boot: EngineBoot, setup: SetupResult) => string;
  /**
   * Run the engine on an instance, when its user data does not (e.g. an
   * ECS service). Returns an Output that resolves once it is declared, so
   * the namespace waits for it.
   */
  readonly engine?: (
    instance: EngineInstance,
    context: EngineContext,
  ) => Effect.Effect<Output.Output<unknown>, never, Req>;
}

/** Values the host's setup declared, for its user data. */
export type SetupResult = Record<string, string>;

/** The cluster-wide values an engine needs. */
export interface EngineContext {
  readonly image: string;
  /** The admin token's secret, for an engine that reads it as ECS `secrets`. */
  readonly tokenSecret: SecretsManager.Secret;
  readonly bucket: Output.Output<string>;
  readonly region: Output.Output<string>;
  /** Grants on the bucket, for an engine that runs under a role of its own. */
  readonly storagePolicy: Input<IAM.PolicyStatement>[];
}

/** Build an AWS control plane on the given host. */
export const makeControlPlane = <Req>(
  id: string,
  props: ControlPlaneProps,
  host: ControlPlaneHost<Req>,
) =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const instances = props.instances ?? 3;
      const image = props.image ?? DEFAULT_ENGINE_IMAGE;

      const token = yield* adminToken(id);
      const cidrBlock = props.cidrBlock ?? "10.42.0.0/16";
      // The load balancer needs subnets in two zones, even for one instance.
      const network = yield* EC2.Network(`${id}Network`, {
        cidrBlock,
        availabilityZones: Math.min(Math.max(instances, 2), 3),
        gatewayEndpoints: ["s3"],
      });
      const zones = network.availabilityZones.length;
      const bucket = yield* S3.Bucket(`${id}Data`, { forceDestroy: true });

      const storagePolicy: Input<IAM.PolicyStatement>[] = [
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [bucket.bucketArn] },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: [Output.interpolate`${bucket.bucketArn}/*`],
        },
      ];
      // The token lives in Secrets Manager: instance user data and task
      // definitions are readable by anyone who can describe them.
      const tokenSecret = yield* SecretsManager.Secret(`${id}AdminTokenSecret`, {
        secretString: token.text,
      });
      const role = yield* IAM.Role(`${id}InstanceRole`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: ["sts:AssumeRole"],
            },
          ],
        },
        managedPolicyArns: host.managedPolicyArns,
        inlinePolicies: {
          Storage: { Version: "2012-10-17", Statement: storagePolicy },
          AdminToken: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [tokenSecret.secretArn],
              },
            ],
          },
        },
      });
      const profile = yield* IAM.InstanceProfile(`${id}InstanceProfile`, {
        roleName: role.roleName,
      });

      // The load balancer is internal: CloudFront reaches it through a VPC
      // origin, and nodes in the VPC reach it directly.
      const loadBalancerGroup = yield* EC2.SecurityGroup(`${id}LoadBalancerGroup`, {
        vpcId: network.vpcId,
        description: "Rivet control plane load balancer",
        ingress: [
          { ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: cidrBlock },
          // A VPC origin forwards with CloudFront's origin-facing addresses.
          {
            ipProtocol: "tcp",
            fromPort: 80,
            toPort: 80,
            prefixListId: EC2.managedPrefixListId("com.amazonaws.global.cloudfront.origin-facing"),
          },
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      const engineGroup = yield* EC2.SecurityGroup(`${id}EngineGroup`, {
        vpcId: network.vpcId,
        description: "Rivet control plane instances",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: API_PORT,
            toPort: API_PORT,
            referencedGroupId: loadBalancerGroup.groupId,
          },
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      // The peer port is plaintext and unauthenticated: only instances reach it.
      yield* EC2.SecurityGroupRule(`${id}PeerRule`, {
        groupId: engineGroup.groupId,
        type: "ingress",
        ipProtocol: "tcp",
        fromPort: PEER_PORT,
        toPort: PEER_PORT,
        referencedGroupId: engineGroup.groupId,
      });
      const nodeGroup = yield* EC2.SecurityGroup(`${id}NodeGroup`, {
        vpcId: network.vpcId,
        description: "Rivet nodes",
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });

      const targets = yield* ELBv2.TargetGroup(`${id}Engines`, {
        vpcId: network.vpcId,
        port: API_PORT,
        protocol: "HTTP",
        targetType: "instance",
        healthCheckPath: "/health",
        matcher: { HttpCode: "200" },
      });
      const loadBalancer = yield* ELBv2.LoadBalancer(`${id}LoadBalancer`, {
        type: "application",
        scheme: "internal",
        subnets: network.publicSubnetIds,
        securityGroups: [loadBalancerGroup.groupId],
        // Nodes hold one long-lived connection each.
        attributes: { "idle_timeout.timeout_seconds": "3600" },
      });
      const listener = yield* ELBv2.Listener(`${id}Listener`, {
        loadBalancerArn: loadBalancer.loadBalancerArn,
        port: 80,
        protocol: "HTTP",
        targetGroupArn: targets.targetGroupArn,
      });

      const setup: Output.Output<SetupResult> =
        host.setup === undefined ? Output.literal({}) : yield* host.setup();
      const context: EngineContext = {
        image,
        tokenSecret,
        bucket: bucket.bucketName,
        region: bucket.region,
        storagePolicy,
      };
      // Everything the namespace waits for, so that everything using the
      // control plane (pools, through the namespace) is deleted before any of
      // it, while the engines still run with their disks.
      const ready: Output.Output<unknown>[] = [listener.listenerArn];
      for (let i = 0; i < instances; i++) {
        const zone = network.availabilityZones[i % zones]!;
        const disk = yield* EC2.Volume(`${id}Disk${i}`, {
          availabilityZone: zone,
          size: props.diskSize ?? 20,
          volumeType: "gp3",
          encrypted: true,
        });
        const instance = yield* EC2.Instance(`${id}Instance${i}`, {
          imageId: host.imageId,
          instanceType: props.instanceType ?? "t3.medium",
          subnetId: network.publicSubnetIds[i % zones]!,
          securityGroupIds: [engineGroup.groupId],
          instanceProfileName: profile.instanceProfileName,
          associatePublicIpAddress: true,
          userData: Output.all(
            tokenSecret.secretArn,
            disk.volumeId,
            bucket.bucketName,
            bucket.region,
            setup,
          ).pipe(
            Output.map(([tokenSecretArn, volumeId, bucketName, region, values]) =>
              host.userData(
                { index: i, image, tokenSecretArn, volumeId, bucket: bucketName, region },
                values,
              ),
            ),
          ),
        });
        const attachment = yield* EC2.VolumeAttachment(`${id}DiskAttachment${i}`, {
          volumeId: disk.volumeId,
          instanceId: instance.instanceId,
          device: "/dev/sdf",
        });
        const target = yield* ELBv2.TargetGroupAttachment(`${id}Target${i}`, {
          targetGroupArn: targets.targetGroupArn,
          targetId: instance.instanceId,
          port: API_PORT,
        });
        ready.push(target.targetId, attachment.volumeId);
        if (host.engine !== undefined) {
          ready.push(yield* host.engine({ index: i, instance }, context));
        }
      }

      // HTTPS without a domain of your own: CloudFront's address, in front of
      // the internal load balancer through a VPC origin. Nothing is cached:
      // the cache policy only exists to forward `Authorization`, which an
      // origin request policy can't, and it never outlives a response that
      // doesn't ask to be cached.
      const origin = yield* CloudFront.VpcOrigin(`${id}Origin`, {
        arn: loadBalancer.loadBalancerArn,
        httpPort: 80,
        originProtocolPolicy: "http-only",
      });
      const cachePolicy = yield* CloudFront.CachePolicy(`${id}CachePolicy`, {
        comment: "Rivet control plane: forward credentials, cache nothing",
        minTTL: 0,
        defaultTTL: 0,
        maxTTL: "1 second",
        parametersInCacheKeyAndForwardedToOrigin: {
          EnableAcceptEncodingGzip: false,
          HeadersConfig: {
            HeaderBehavior: "whitelist",
            Headers: { Quantity: 2, Items: ["Authorization", "x-rivet-token"] },
          },
          CookiesConfig: { CookieBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "all" },
        },
      });
      const distribution = yield* CloudFront.Distribution(`${id}Distribution`, {
        comment: "Rivet control plane",
        // CloudFront keeps an error response for 10 seconds by default,
        // whatever the cache policy says: a read right after a write would
        // see the 404 from before it.
        customErrorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map(
          (code) => ({ ErrorCode: code, ErrorCachingMinTTL: 0 }),
        ),
        origins: [
          {
            id: "engines",
            domainName: loadBalancer.dnsName,
            vpcOriginConfig: {
              vpcOriginId: origin.vpcOriginId,
              // The longest CloudFront allows without a quota increase: a
              // call that answers later than this fails with 504.
              originReadTimeout: "60 seconds",
              originKeepaliveTimeout: "60 seconds",
            },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: "engines",
          viewerProtocolPolicy: "https-only",
          allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          cachedMethods: ["GET", "HEAD"],
          compress: false,
          cachePolicyId: cachePolicy.cachePolicyId,
          originRequestPolicyId: CloudFront.MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
        },
      });
      ready.push(distribution.distributionId);
      const endpoint = Output.interpolate`https://${distribution.domainName}`;
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the instances serve, once they all run.
        endpoint: Output.all(endpoint, Output.all(...ready)).pipe(Output.map(([url]) => url)),
        token: token.text,
      });
      return {
        endpoint,
        // Nodes in the VPC skip CloudFront.
        nodeEndpoint: Output.interpolate`http://${loadBalancer.dnsName}`,
        network: Network(network, nodeGroup),
        token: token.text,
        namespace: namespace.name,
      };
    }),
  );
