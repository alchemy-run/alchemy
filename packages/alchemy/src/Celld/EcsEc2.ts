import type * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as AutoScaling from "../AWS/AutoScaling/index.ts";
import type { SecurityGroupId } from "../AWS/EC2/SecurityGroup.ts";
import type { SubnetId } from "../AWS/EC2/Subnet.ts";
import * as ECS from "../AWS/ECS/index.ts";
import * as IAM from "../AWS/IAM/index.ts";
import type { Input } from "../Input.ts";
import { EcsHostConfigurationError } from "./EcsHostConfig.ts";
import type { FleetProps } from "./Fleet.ts";

export const CELLD_SCRATCH_PATH = "/var/lib/celld";
export const RUNSC_RELEASE = "20250915.0";
const RUNSC_SHA512 = {
  X86_64:
    "aa008e497d50cc97eb3103645a80ede5f40f13b0d55c675ef3774ecc60cac299e3941253daf9fcbbd097294d7826a2dcf2343eec39a6b52646ec9deaceb3c9cc",
  ARM64:
    "a31a71a24d20e5800c76bf44a9cf33af0dec063c8657fac65805994eef6b136bc66bf4780a4c8acfe0c9d87733c30432b1e4c31cf9994a23d448c8af0865dcd7",
};

export interface Ec2NodeSizing {
  readonly architecture: "X86_64" | "ARM64";
  readonly hostMemoryMiB: number;
  readonly hostCpuUnits: number;
  readonly reservedMemoryMiB: number;
  readonly kernelReserveMiB: number;
  readonly memoryMiB: number;
  readonly cpuUnits: number;
  readonly nodes: number;
}

export const resolveEc2NodeSizing = (
  instance: ec2.InstanceTypeInfo | undefined,
  props: Pick<FleetProps, "instances" | "cpuArchitecture" | "cpu" | "memory">,
  reservedMemoryMiB = 1024,
) =>
  Effect.gen(function* () {
    const architectures = instance?.ProcessorInfo?.SupportedArchitectures ?? [];
    const architecture =
      props.cpuArchitecture ??
      (architectures.includes("x86_64") ? "X86_64" : "ARM64");
    const hostMemoryMiB = instance?.MemoryInfo?.SizeInMiB ?? 0;
    const hostCpuUnits = (instance?.VCpuInfo?.DefaultVCpus ?? 0) * 1024;
    if (
      !architectures.includes(architecture === "ARM64" ? "arm64" : "x86_64") ||
      !instance?.SupportedVirtualizationTypes?.includes("hvm") ||
      hostMemoryMiB === 0 ||
      hostCpuUnits === 0
    ) {
      return yield* new EcsHostConfigurationError({
        message:
          "The EC2 instance must support the selected Linux HVM architecture and report its CPU/memory capacity.",
      });
    }
    if (typeof props.instances === "object") {
      return yield* new EcsHostConfigurationError({
        message:
          "EC2 Celld fleets currently require a fixed instance count. ECS task CPU autoscaling excludes child containers and cannot safely size this host.",
      });
    }
    const nodes = props.instances ?? 2;
    // ECS registers Linux MemTotal, which is smaller than the EC2 advertised RAM.
    const kernelReserveMiB = Math.max(256, Math.ceil(hostMemoryMiB * 0.03));
    const memoryMiB =
      props.memory ?? hostMemoryMiB - reservedMemoryMiB - kernelReserveMiB;
    const cpuUnits = props.cpu ?? hostCpuUnits - 256;
    if (
      !Number.isInteger(nodes) ||
      nodes < 1 ||
      !Number.isInteger(reservedMemoryMiB) ||
      reservedMemoryMiB < 1024 ||
      !Number.isInteger(memoryMiB) ||
      memoryMiB < 1024 ||
      memoryMiB > hostMemoryMiB - reservedMemoryMiB - kernelReserveMiB ||
      !Number.isInteger(cpuUnits) ||
      cpuUnits < 256 ||
      cpuUnits > hostCpuUnits - 256
    ) {
      return yield* new EcsHostConfigurationError({
        message:
          "EC2 requires a positive fixed node count, at least 1024 MiB of OS/Docker headroom and 256 CPU units of host headroom, with the Celld budget fitting the remaining host capacity.",
      });
    }
    return {
      architecture,
      hostMemoryMiB,
      hostCpuUnits,
      reservedMemoryMiB,
      kernelReserveMiB,
      memoryMiB,
      cpuUnits,
      nodes,
    } satisfies Ec2NodeSizing;
  });

/** ECS starts only after Docker, runsc, and the same-path host scratch are ready. */
export const makeEc2UserData = (
  clusterName: string,
  region: string,
  sizing: Ec2NodeSizing,
  runtime: "runsc" | undefined,
) => `#!/bin/bash
set -euo pipefail
systemctl stop ecs
mkdir -p /etc/ecs /etc/docker /var/lib/celld-host ${CELLD_SCRATCH_PATH} /etc/systemd/system/ecs.service.d
cat > /etc/systemd/system/ecs.service.d/celld.conf <<'GATE'
[Unit]
ConditionPathExists=/var/lib/celld-host/ready
GATE
systemctl daemon-reload
chmod 700 /var/lib/celld-host ${CELLD_SCRATCH_PATH}
dnf install -y jq
command -v curl >/dev/null || dnf install -y curl-minimal
HOST_MEMORY_MIB="$(awk '/MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
if [ "$HOST_MEMORY_MIB" -lt ${sizing.memoryMiB + sizing.reservedMemoryMiB} ]; then echo 'Host memory is below the declared Celld budget and OS headroom' >&2; exit 1; fi
TOKEN="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)"
curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4 > /var/lib/celld-host/private-ip
cat > /etc/ecs/ecs.config <<'ECS_CONFIG'
ECS_CLUSTER=${clusterName}
ECS_ENABLE_TASK_IAM_ROLE=true
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true
ECS_ENABLE_TASK_CPU_MEM_LIMIT=true
ECS_RESERVED_MEMORY=${sizing.reservedMemoryMiB}
ECS_CONTAINER_STOP_TIMEOUT=120s
ECS_INSTANCE_ATTRIBUTES={"celld.dedicated":"true"}
ECS_CONFIG
${
  runtime === "runsc"
    ? `cd /var/lib/celld-host
curl --fail --silent --show-error --location --connect-timeout 5 --max-time 120 --retry 3 -o runsc https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE}/${sizing.architecture === "ARM64" ? "aarch64" : "x86_64"}/runsc
printf '%s  runsc\\n' '${RUNSC_SHA512[sizing.architecture]}' > runsc.sha512
sha512sum -c runsc.sha512
install -m 0755 runsc /usr/local/bin/runsc
/usr/local/bin/runsc --version
if [ ! -f /etc/docker/daemon.json ]; then printf '{}' > /etc/docker/daemon.json; fi
jq '.runtimes.runsc = {"path":"/usr/local/bin/runsc"}' /etc/docker/daemon.json > /etc/docker/daemon.json.next
mv /etc/docker/daemon.json.next /etc/docker/daemon.json
`
    : ""
}
cat > /usr/local/sbin/celld-host-stop <<'STOP'
#!/bin/bash
set -euo pipefail
docker ps -q --filter label=com.amazonaws.ecs.container-name=celld | xargs -r docker stop -t 120
docker ps -aq --filter label=celld.node | xargs -r docker rm -f
STOP
chmod 0755 /usr/local/sbin/celld-host-stop
cat > /etc/systemd/system/celld-host-cleanup.service <<'UNIT'
[Unit]
Description=Drain Celld and reap host child containers before Docker shutdown
After=docker.service ecs.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/usr/local/sbin/celld-host-stop
TimeoutStopSec=150
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl restart docker
chmod 0600 /var/run/docker.sock
${runtime === "runsc" ? "docker info --format '{{json .Runtimes}}' | jq -e 'has(\"runsc\")'" : "docker info >/dev/null"}
cat > /usr/local/sbin/celld-host-register <<'REGISTER'
#!/bin/bash
set -euo pipefail
TOKEN="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)"
ROLE="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/)"
CREDS="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE")"
KEY="$(printf '%s' "$CREDS" | jq -er .AccessKeyId)"
SECRET="$(printf '%s' "$CREDS" | jq -er .SecretAccessKey)"
SESSION="$(printf '%s' "$CREDS" | jq -er .Token)"
READY=0
for attempt in 1 2 3 4 5 6 7 8; do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 --aws-sigv4 'aws:amz:${region}:ecs' --user "$KEY:$SECRET" -H "X-Amz-Security-Token: $SESSION" -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: AmazonEC2ContainerServiceV20141113.DescribeClusters' --data '{"clusters":["${clusterName}"]}' 'https://ecs.${region}.amazonaws.com' | jq -e '.clusters[0].capacityProviders | index("${clusterName}-capacity") != null' >/dev/null; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != 1 ]; then echo 'ECS capacity provider association is not ready; refusing host registration' >&2; exit 1; fi
unset KEY SECRET SESSION CREDS TOKEN
touch /var/lib/celld-host/ready
systemctl enable celld-host-cleanup
systemctl enable --now --no-block ecs
systemctl start --no-block celld-host-cleanup
REGISTER
chmod 0700 /usr/local/sbin/celld-host-register
cat > /etc/systemd/system/celld-host-register.service <<'REGISTER_UNIT'
[Unit]
Description=Register Celld host after its ECS capacity provider is associated
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service
StartLimitIntervalSec=0
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/celld-host-register
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
[Install]
WantedBy=multi-user.target
REGISTER_UNIT
systemctl daemon-reload
systemctl enable --now --no-block celld-host-register
`;

export const ec2NodeTaskConfiguration = (runtime: "runsc" | undefined) => ({
  networkMode: "host" as const,
  requiresCompatibilities: ["EC2" as const],
  placementConstraints: [
    { type: "distinctInstance" as const },
    {
      type: "memberOf" as const,
      expression: "attribute:celld.dedicated == true",
    },
  ],
  deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200 },
  container: {
    name: "celld",
    privileged: false,
    stopTimeout: 120,
    linuxParameters: { capabilities: { drop: ["ALL"] } },
    portMappings: [8080, 8081].map((port) => ({
      containerPort: port,
      hostPort: port,
      protocol: "tcp" as const,
    })),
    mountPoints: [
      {
        sourceVolume: "docker",
        containerPath: "/var/run/docker.sock",
        readOnly: false,
      },
      {
        sourceVolume: "scratch",
        containerPath: CELLD_SCRATCH_PATH,
        readOnly: false,
      },
      {
        sourceVolume: "host",
        containerPath: "/var/lib/celld-host",
        readOnly: true,
      },
    ],
  },
  volumes: [
    { name: "docker", host: { sourcePath: "/var/run/docker.sock" } },
    { name: "scratch", host: { sourcePath: CELLD_SCRATCH_PATH } },
    { name: "host", host: { sourcePath: "/var/lib/celld-host" } },
  ],
  env: {
    DOCKER_HOST: "unix:///var/run/docker.sock",
    TMPDIR: CELLD_SCRATCH_PATH,
    CELLD_CONTAINER_RUNTIME: runtime ?? "runc",
  },
});

export const composeEc2Capacity = (options: {
  readonly identity: string;
  readonly region: string;
  readonly instanceType: string;
  readonly sizing: Ec2NodeSizing;
  readonly runtime?: "runsc";
  readonly subnetIds: Input<SubnetId[]>;
  readonly securityGroupIds: Input<SecurityGroupId>[];
  readonly tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // A literal cluster name breaks the cluster → provider → ASG → user-data cycle.
    const clusterName = yield* Effect.sync(
      () =>
        `celld-${createHash("sha256").update(options.identity).digest("hex").slice(0, 32)}`,
    );
    const role = yield* IAM.Role("HostRole", {
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
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
      ],
      inlinePolicies: {
        ClusterReadiness: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ecs:DescribeClusters"],
              Resource: [
                `arn:aws:ecs:${options.region}:*:cluster/${clusterName}`,
              ],
            },
          ],
        },
      },
      tags: options.tags,
    });
    const profile = yield* IAM.InstanceProfile("HostProfile", {
      roleName: role.roleName,
      tags: options.tags,
    });
    const template = yield* AutoScaling.LaunchTemplate("HostTemplate", {
      imageId: `resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/${options.sizing.architecture === "ARM64" ? "arm64/" : ""}recommended/image_id`,
      instanceType: options.instanceType,
      instanceProfileName: profile.instanceProfileName,
      securityGroupIds: options.securityGroupIds,
      associatePublicIpAddress: true,
      userData: makeEc2UserData(
        clusterName,
        options.region,
        options.sizing,
        options.runtime,
      ),
      tags: options.tags,
    });
    const group = yield* AutoScaling.AutoScalingGroup("Hosts", {
      launchTemplate: {
        launchTemplateId: template.launchTemplateId,
        version: template.latestVersionNumber,
      },
      subnetIds: options.subnetIds,
      // One spare host provides replacement capacity without co-locating celld tasks.
      minSize: options.sizing.nodes + 1,
      maxSize: options.sizing.nodes + 1,
      desiredCapacity: options.sizing.nodes + 1,
      healthCheckType: "EC2",
      healthCheckGracePeriod: "5 minutes",
      tags: options.tags,
    });
    const provider = yield* ECS.CapacityProvider("Capacity", {
      name: `${clusterName}-capacity`,
      autoScalingGroupArn: group.autoScalingGroupArn,
      managedScaling: { status: "DISABLED" },
      managedTerminationProtection: "DISABLED",
      managedDraining: "ENABLED",
      tags: options.tags,
    });
    const cluster = yield* ECS.Cluster("Cluster", {
      clusterName,
      capacityProviders: [provider.name],
      defaultCapacityProviderStrategy: [
        { capacityProvider: provider.name, weight: 1 },
      ],
      tags: options.tags,
    });
    return {
      cluster,
      capacityProviderStrategy: [
        { capacityProvider: provider.name, weight: 1 },
      ],
      autoScalingGroupName: group.autoScalingGroupName,
      hostCount: options.sizing.nodes + 1,
    };
  });
