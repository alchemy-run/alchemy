import * as EC2 from "@alchemy.run/aws/EC2";
import * as ECS from "@alchemy.run/aws/ECS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  DATA_PATH,
  engineEnvironment,
  makeControlPlane,
  mountDataDisk,
  PEER_PORT,
  type ControlPlaneProps,
} from "./internal/ControlPlane.ts";

export interface EcsControlPlaneProps extends ControlPlaneProps {
  /**
   * CPU units reserved for each engine (1024 = 1 vCPU).
   * @default 1024
   */
  cpu?: number;
  /**
   * Memory reserved for each engine, in MiB.
   * @default 2048
   */
  memory?: number;
}

/** The instance attribute each engine's service is placed by. */
const INSTANCE_ATTRIBUTE = "rivet.instance";

/**
 * A Rivet control plane on ECS, as a `Rivet.Cluster` Layer, the topology of
 * Rivet's own AWS guide: EC2 instances across Availability Zones register
 * with an ECS cluster, each with a data disk of its own, and each runs one
 * engine as an ECS service pinned to it with host networking. An S3 bucket
 * holds the durable copy of every actor's data and an Application Load
 * Balancer sits in front. A namespace is created for the stage.
 *
 * Each data disk is its own EBS volume, so it outlives the instance it is
 * attached to. A new engine image rolls out as an ECS deployment onto the
 * same instances, one engine at a time per service.
 *
 * ### Running a control plane on ECS
 * **Example:** Three instances
 * ```typescript
 * export const Cluster = RivetAWS.EcsControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger engines
 * ```typescript
 * export const Cluster = RivetAWS.EcsControlPlane("Rivet", {
 *   instanceType: "m7i.xlarge",
 *   cpu: 3072,
 *   memory: 12288,
 * });
 * ```
 *
 * @primitive
 */
export const EcsControlPlane = (id: string, props: EcsControlPlaneProps = {}) =>
  makeControlPlane(id, props, {
    // The ECS-optimized image runs the ECS agent once user data finishes.
    imageId: EC2.image({ owners: ["amazon"], name: ["al2023-ami-ecs-hvm-2023.*-x86_64"] }),
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"],
    setup: () =>
      Effect.gen(function* () {
        const cluster = yield* ECS.Cluster(`${id}EcsCluster`, {});
        return cluster.clusterName.pipe(Output.map((name) => ({ cluster: name })));
      }),
    // The disk is mounted before the ECS agent starts and places the engine.
    userData: (boot, setup) => `#!/bin/bash
set -euo pipefail
${mountDataDisk(boot.volumeId)}
cat > /etc/ecs/ecs.config <<'ECS_CONFIG'
ECS_CLUSTER=${setup.cluster}
ECS_INSTANCE_ATTRIBUTES={"${INSTANCE_ATTRIBUTE}":"${boot.index}"}
ECS_CONTAINER_STOP_TIMEOUT=120s
ECS_CONFIG
`,
    engine: ({ index, instance }, context) =>
      Effect.gen(function* () {
        const cluster = yield* ECS.Cluster(`${id}EcsCluster`, {});
        const service = yield* ECS.Service(`${id}Engine${index}`, {
          cluster,
          image: context.image,
          launchType: "EC2",
          requiresCompatibilities: ["EC2"],
          networkMode: "host",
          cpu: props.cpu ?? 1024,
          memory: props.memory ?? 2048,
          desiredCount: 1,
          placementConstraints: [
            {
              type: "memberOf",
              expression: `attribute:${INSTANCE_ATTRIBUTE} == ${index}`,
            },
          ],
          // One engine per instance on host ports: stop the old one first.
          deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 },
          volumes: [{ name: "data", host: { sourcePath: DATA_PATH } }],
          container: {
            mountPoints: [{ sourceVolume: "data", containerPath: DATA_PATH }],
            stopTimeout: 120,
          },
          // Task environment values are plain strings.
          env: Output.all(
            context.token,
            context.bucket,
            context.region,
            instance.privateIpAddress,
          ).pipe(
            Output.map(([token, bucket, region, privateIp]) =>
              engineEnvironment({
                token: Redacted.value(token),
                bucket,
                region,
                advertiseAddress: `${privateIp}:${PEER_PORT}`,
              }),
            ),
          ),
        });
        return service.serviceArn;
      }),
  });
