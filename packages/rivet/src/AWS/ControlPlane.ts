import * as EC2 from "@alchemy.run/aws/EC2";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import * as IAM from "@alchemy.run/aws/IAM";
import * as S3 from "@alchemy.run/aws/S3";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetAWS.ControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0-preview.4";

/** Where each instance keeps its disk, and where the engine stores its log. */
const DATA_PATH = "/var/lib/rivet";

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
   * @default "rivetdev/engine:3.0.0-preview.4"
   */
  image?: string;
  /**
   * IPv4 CIDR block of the control plane's VPC.
   * @default "10.42.0.0/16"
   */
  cidrBlock?: string;
}

/** Boot one instance: mount its data disk, then run the engine on the host network. */
const userData = (options: {
  readonly image: string;
  readonly token: string;
  readonly volumeId: string;
  readonly bucket: string;
  readonly region: string;
}) => `#!/bin/bash
set -euo pipefail
dnf install -y docker
systemctl enable --now docker

# The data disk is attached after the instance starts.
DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${options.volumeId.replace("-", "")}"
for attempt in $(seq 1 120); do
  [ -e "$DEVICE" ] && break
  sleep 5
done
[ -e "$DEVICE" ] || { echo "data disk ${options.volumeId} never attached" >&2; exit 1; }
blkid "$DEVICE" >/dev/null || mkfs.xfs "$DEVICE"
mkdir -p ${DATA_PATH}
mount "$DEVICE" ${DATA_PATH}
echo "$DEVICE ${DATA_PATH} xfs defaults,nofail 0 2" >> /etc/fstab

IMDS_TOKEN="$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)"
PRIVATE_IP="$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)"

docker run -d --name rivet-engine --restart always --network host \\
  -v ${DATA_PATH}:${DATA_PATH} \\
  -e RIVET__AUTH__ADMIN_TOKEN='${options.token}' \\
  -e RIVET__STORAGE__LOG_DIRECTORY=${DATA_PATH} \\
  -e RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET='${options.bucket}' \\
  -e RIVET__OBJECT_STORAGE__PRIMARY__S3__REGION='${options.region}' \\
  -e RIVET__API_PEER__ADVERTISE_ADDRESS="$PRIVATE_IP:6421" \\
  -e RIVET__TELEMETRY__ENABLED=false \\
  '${options.image}'
`;

/**
 * A Rivet control plane on AWS, as a `Rivet.Cluster` Layer: EC2 instances
 * across Availability Zones, each running the engine with a data disk of its
 * own, an S3 bucket for the durable copy of every actor's data, and an
 * Application Load Balancer in front. Instances find each other through the
 * bucket and talk on a private port only they can reach. A namespace is
 * created for the stage.
 *
 * Each data disk is its own EBS volume, so it outlives the instance it is
 * attached to: a replaced instance (a new engine image, for example) mounts
 * the same disk again.
 *
 * Pools of nodes run in the control plane's VPC — `RivetAWS.EcsPool`.
 *
 * ### Running a control plane on AWS
 * **Example:** Three instances
 * ```typescript
 * export const Cluster = RivetAWS.ControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger instances and disks
 * ```typescript
 * export const Cluster = RivetAWS.ControlPlane("Rivet", {
 *   instances: 5,
 *   instanceType: "m7i.large",
 *   diskSize: 100,
 * });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (id: string, props: ControlPlaneProps = {}) =>
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

      const token = yield* Random(`${id}AdminToken`, { bytes: 32 });
      // The load balancer needs subnets in two zones, even for one instance.
      const network = yield* EC2.Network(`${id}Network`, {
        cidrBlock: props.cidrBlock ?? "10.42.0.0/16",
        availabilityZones: Math.min(Math.max(instances, 2), 3),
        gatewayEndpoints: ["s3"],
      });
      const zones = network.availabilityZones.length;
      const bucket = yield* S3.Bucket(`${id}Data`, { forceDestroy: true });

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
        inlinePolicies: {
          Storage: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: [bucket.bucketArn],
              },
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          },
        },
      });
      const profile = yield* IAM.InstanceProfile(`${id}InstanceProfile`, {
        roleName: role.roleName,
      });

      const loadBalancerGroup = yield* EC2.SecurityGroup(`${id}LoadBalancerGroup`, {
        vpcId: network.vpcId,
        description: "Rivet control plane load balancer",
        ingress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" }],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      const engineGroup = yield* EC2.SecurityGroup(`${id}EngineGroup`, {
        vpcId: network.vpcId,
        description: "Rivet control plane instances",
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 6420,
            toPort: 6420,
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
        fromPort: 6421,
        toPort: 6421,
        referencedGroupId: engineGroup.groupId,
      });
      const nodeGroup = yield* EC2.SecurityGroup(`${id}NodeGroup`, {
        vpcId: network.vpcId,
        description: "Rivet nodes",
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });

      const targets = yield* ELBv2.TargetGroup(`${id}Engines`, {
        vpcId: network.vpcId,
        port: 6420,
        protocol: "HTTP",
        targetType: "instance",
        healthCheckPath: "/health",
        matcher: { HttpCode: "200" },
      });
      const loadBalancer = yield* ELBv2.LoadBalancer(`${id}LoadBalancer`, {
        type: "application",
        scheme: "internet-facing",
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

      const amazonLinux = EC2.amazonLinux2023();
      const attached = [];
      for (let i = 0; i < instances; i++) {
        const zone = network.availabilityZones[i % zones]!;
        const disk = yield* EC2.Volume(`${id}Disk${i}`, {
          availabilityZone: zone,
          size: props.diskSize ?? 20,
          volumeType: "gp3",
          encrypted: true,
        });
        const instance = yield* EC2.Instance(`${id}Instance${i}`, {
          imageId: amazonLinux,
          instanceType: props.instanceType ?? "t3.medium",
          subnetId: network.publicSubnetIds[i % zones]!,
          securityGroupIds: [engineGroup.groupId],
          instanceProfileName: profile.instanceProfileName,
          associatePublicIpAddress: true,
          userData: Output.all(token.text, disk.volumeId, bucket.bucketName, bucket.region).pipe(
            Output.map(([text, volumeId, bucketName, region]) =>
              Redacted.make(
                userData({
                  image,
                  token: Redacted.value(text),
                  volumeId,
                  bucket: bucketName,
                  region,
                }),
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
          port: 6420,
        });
        attached.push(target.targetId, attachment.volumeId);
      }

      const endpoint = Output.interpolate`http://${loadBalancer.dnsName}`;
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Ordered after the listener, every instance and every disk: the
        // namespace is created through the API they serve. Everything that
        // uses the control plane (pools, through the namespace) is then
        // deleted before any of them, while the engines still have their disks.
        endpoint: Output.all(endpoint, listener.listenerArn, ...attached).pipe(
          Output.map(([url]) => url),
        ),
        token: token.text,
      });
      return {
        endpoint,
        network: {
          kind: "aws",
          vpcId: network.vpcId,
          subnetIds: network.publicSubnetIds,
          securityGroupId: nodeGroup.groupId,
        },
        token: token.text,
        namespace: namespace.name,
      };
    }),
  );
