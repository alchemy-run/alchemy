import type * as SandboxWorkspace from "@alchemy.run/sandbox/Workspace";
import { workspaceHost, type WorkspaceHostService } from "@alchemy.run/sandbox/Workspace";
import {
  WORKSPACE_SERVICE,
  type WorkspaceServiceDescriptor,
} from "@alchemy.run/sandbox/WorkspaceService";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutoScalingGroup } from "../AutoScaling/AutoScalingGroup.ts";
import { ubuntu2404 } from "../EC2/Image.ts";
import { Network } from "../EC2/Network.ts";
import { SecurityGroup } from "../EC2/SecurityGroup.ts";
import { Listener } from "../ELBv2/Listener.ts";
import { LoadBalancer } from "../ELBv2/LoadBalancer.ts";
import { TargetGroup } from "../ELBv2/TargetGroup.ts";
import { Bucket } from "../S3/Bucket.ts";
import { hostTemplate } from "./WorkspaceFleet.ts";
import { WorkspaceImage } from "./WorkspaceImage.ts";
import type { HostConfig } from "./WorkspaceServer.ts";

export interface WorkspaceProps {
  /**
   * The image commands run on. Its whole root is the machine a command
   * sees; its `path` directory is what a new session starts with.
   */
  dockerfile: string;
  /** Where the workspace is, in the image and to commands. @default "/workspace" */
  path?: string;
  /** The workspace's size in bytes. @default 4 GiB */
  size?: number;
  /** @default "ext4" */
  filesystem?: "ext4" | "btrfs";
  /**
   * How commands are isolated from the host and each other:
   * `"container"` (runc: namespaces and seccomp, native speed, the host's
   * kernel), `"gvisor"` (runsc: a kernel in user space; slower at file
   * operations), or `"none"` (on the host itself).
   * @default "container"
   */
  isolation?: "container" | "gvisor" | "none";
  /**
   * Where a command runs: `"pinned"` on the session's mounted head,
   * `"serverless"` on a fork that merges back, `"automatic"` serverless
   * until a command leaves processes running.
   * @default "automatic"
   */
  placement?: "pinned" | "serverless" | "automatic";
  hosts?: {
    /** Graviton (`t4g`, `c7g`, …) or x86. @default "t4g.small" */
    instanceType?: string;
    /** @default 1 */
    min?: number;
    /** @default 1 */
    max?: number;
    /** Spot instances: cheaper, interruptible. @default false */
    spot?: boolean;
  };
  /** How long an unused session stays mounted on its host. @default "2 minutes" */
  idle?: Duration.Input;
  /** The VPC's CIDR block. @default "10.90.0.0/16" */
  cidrBlock?: string;
  /**
   * An ACM certificate for HTTPS on the load balancer. Without one the
   * service is served over HTTP on the load balancer's own name.
   */
  certificateArn?: string;
}

const PORT = 8080;

const isGraviton = (instanceType: string) => /^[a-z]+\d+[a-z]*g[a-z]*\./.test(instanceType);

/**
 * Hosts on EC2 for a `Sandbox.Workspace`: commands run on the hosts, in
 * containers on the workspace's image, next to the sessions' disks.
 * Workers, Lambda functions and anything else reach it over HTTP through
 * its load balancer.
 *
 * ### Declaring the hosts
 * **Example:** A workspace on Graviton spot instances
 * ```typescript
 * // src/Workspace.aws.ts
 * import * as AWS from "@alchemy.run/aws";
 * import { Workspace } from "./Workspace.ts";
 *
 * export default AWS.Workspace(Workspace, {
 *   dockerfile: `FROM node:24-bookworm
 * RUN mkdir -p /workspace`,
 *   hosts: { instanceType: "t4g.small", spot: true },
 * });
 * ```
 *
 * ### Using it from a Worker
 * The same `yield* Workspace` as on any host: a Worker on Cloudflare or a
 * Lambda function reaches the hosts over HTTP.
 *
 * **Example:** Commands from a Cloudflare Worker
 * ```typescript
 * const workspace = yield* Workspace;
 * const result = yield* workspace.exec("session-1", "npm test");
 * ```
 *
 * @binding
 * @product Workspace
 * @category Workspace
 */
export const Workspace = <const D extends SandboxWorkspace.Workspace.Decl.Any>(
  workspace: D,
  props: WorkspaceProps,
): Layer.Layer<SandboxWorkspace.Workspace.Host<SelfOf<D>>, never, any> => {
  const id = workspace.LogicalId;
  const instanceType = props.hosts?.instanceType ?? "t4g.small";
  const platform = isGraviton(instanceType) ? "linux/arm64" : "linux/amd64";
  const tokenKey = sanitizeKey(`ALCHEMY_WORKSPACE_${id}_TOKEN`);
  return Layer.effect(
    workspaceHost(id),
    Effect.gen(function* () {
      const network = yield* Network(`${id}Network`, {
        cidrBlock: props.cidrBlock ?? "10.90.0.0/16",
        availabilityZones: 2,
      });
      const bucket = yield* Bucket(`${id}Store`, { forceDestroy: true });
      const store = Output.interpolate`s3://${bucket.bucketName}/volumes`;
      const binaries = "blockd";
      const image = yield* WorkspaceImage(`${id}Image`, {
        store: store as never,
        dockerfile: props.dockerfile,
        path: props.path ?? "/workspace",
        platform,
        size: props.size ?? 4 * 1024 * 1024 * 1024,
        ...(props.filesystem ? { filesystem: props.filesystem } : {}),
        binaries,
      });
      const token = yield* Random(`${id}WorkspaceToken`, { bytes: 32 });

      const front = yield* SecurityGroup(`${id}FrontSg`, {
        vpcId: network.vpcId,
        description: `the load balancer of workspace ${id}`,
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrIpv4: "0.0.0.0/0",
            description: "http",
          },
          ...(props.certificateArn
            ? [
                {
                  ipProtocol: "tcp",
                  fromPort: 443,
                  toPort: 443,
                  cidrIpv4: "0.0.0.0/0",
                  description: "https",
                },
              ]
            : []),
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0", description: "all outbound" }],
      } as never);
      const hosts = yield* SecurityGroup(`${id}HostSg`, {
        vpcId: network.vpcId,
        description: `the hosts of workspace ${id}`,
        ingress: [
          {
            ipProtocol: "tcp",
            fromPort: PORT,
            toPort: PORT,
            referencedGroupId: front.groupId,
            description: "the load balancer",
          },
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0", description: "all outbound" }],
      } as never);

      const config = Output.all(store, image.image, image.base).pipe(
        Output.map(([storeSpec, imageSnapshot, base]): HostConfig => ({
          id,
          store: storeSpec as string,
          bucket: (storeSpec as string).slice("s3://".length).split("/")[0]!,
          base: base as string,
          image: imageSnapshot as string,
          path: props.path ?? "/workspace",
          isolation: props.isolation ?? "container",
          placement: props.placement ?? "automatic",
          lww: workspace.Options?.lww ?? [],
          idleMs: Duration.toMillis(Duration.fromInputUnsafe(props.idle ?? "2 minutes")),
          binaries,
          port: PORT,
        })),
      );
      const template = yield* hostTemplate(
        // At deploy the service only registers what it binds; hosts read the
        // resolved config from their environment.
        {
          id,
          store: "",
          bucket: "",
          base: "",
          path: props.path ?? "/workspace",
          isolation: props.isolation ?? "container",
          placement: props.placement ?? "automatic",
          lww: [],
          idleMs: 0,
          binaries,
          port: PORT,
        },
        {
          config,
          main: new URL(`./WorkspaceHost${extensionOf(import.meta.url)}`, import.meta.url).href,
          token: token.text,
          imageId: ubuntu2404({
            architecture: platform === "linux/arm64" ? "arm64" : "x86_64",
          }) as never,
          instanceType,
          securityGroupIds: [hosts.groupId],
          spot: props.hosts?.spot ?? false,
          bucketArn: bucket.bucketArn,
        },
      );

      const targets = yield* TargetGroup(`${id}Targets`, {
        vpcId: network.vpcId as never,
        port: PORT,
        protocol: "HTTP",
        targetType: "instance",
        healthCheckPath: "/health",
        healthCheckInterval: "15 seconds",
        healthyThresholdCount: 2,
      });
      const balancer = yield* LoadBalancer(`${id}Front`, {
        type: "application",
        scheme: "internet-facing",
        subnets: network.publicSubnetIds as never,
        securityGroups: [front.groupId] as never,
        // A command's long poll is 25 seconds; leave it room.
        attributes: { "idle_timeout.timeout_seconds": "120" },
      });
      yield* Listener(`${id}Http`, {
        loadBalancerArn: balancer,
        port: 80,
        protocol: "HTTP",
        targetGroupArn: targets,
      });
      if (props.certificateArn) {
        yield* Listener(`${id}Https`, {
          loadBalancerArn: balancer,
          port: 443,
          protocol: "HTTPS",
          certificateArn: props.certificateArn,
          targetGroupArn: targets,
        });
      }
      yield* AutoScalingGroup(`${id}Hosts`, {
        launchTemplate: template as never,
        subnetIds: network.publicSubnetIds as never,
        minSize: props.hosts?.min ?? 1,
        maxSize: props.hosts?.max ?? 1,
        desiredCapacity: props.hosts?.min ?? 1,
        targetGroupArns: [targets.targetGroupArn] as never,
        // A host's first boot installs its tools before it's healthy.
        healthCheckGracePeriod: "10 minutes",
      });

      const url = Output.map(balancer.dnsName, (name) =>
        props.certificateArn ? `https://${name}` : `http://${name}`,
      );
      return {
        descriptor: Output.map(url, (base): WorkspaceServiceDescriptor => ({
          host: WORKSPACE_SERVICE,
          id,
          url: base,
          tokenKey,
        })),
        // The yielding Worker or function gets the service's token.
        bind: Effect.gen(function* () {
          const ctx = yield* CurrentRuntimeContext;
          if (ctx) yield* ctx.set(tokenKey, token.text);
        }),
      } satisfies WorkspaceHostService;
    }),
  ) as unknown as Layer.Layer<SandboxWorkspace.Workspace.Host<SelfOf<D>>, never, any>;
};

const extensionOf = (url: string) => (url.endsWith(".ts") ? ".ts" : ".js");

type SelfOf<D> = D extends SandboxWorkspace.Workspace.Decl<infer Self, any> ? Self : never;
