import type { MicrovmSandboxMemory } from "@alchemy.run/aws/Lambda/MicrovmSandbox";
import { MicrovmSandbox } from "@alchemy.run/aws/Lambda/MicrovmSandbox";
import { sandboxHost } from "@alchemy.run/sandbox/Sandbox";
import { volumeHost } from "@alchemy.run/sandbox/Volume";
import type {
  Workspace as SandboxWorkspace,
  WorkspaceHostService,
} from "@alchemy.run/sandbox/Workspace";
import { workspaceHost } from "@alchemy.run/sandbox/Workspace";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as CoreBinding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Providers } from "../Providers.ts";
import { Volume as R2Volume } from "../R2/Volume.ts";
import { isWorker, type Worker } from "../Workers/Worker.ts";
import type { ContainerInstanceType } from "./SandboxClient.ts";
import { machineHost } from "./WorkspaceMachineHost.ts";
import { machineSandbox } from "./WorkspaceNames.ts";
import {
  hostWorker,
  machineObject,
  sessionObject,
  volumeOf,
  WORKSPACE_HOST,
  type HostConfig,
  type WorkspaceHostDescriptor,
} from "./WorkspaceObjects.ts";

export interface WorkspaceProps {
  /** Each session's disk. @default "8 GB" */
  readonly size?: `${number} GB` | number;
  /**
   * The image commands run in, and where its files come from: the base
   * every session starts from is `path` in this image. The image must run as
   * root (machines mount the disk).
   */
  readonly dockerfile: string;
  /** Where the session's disk is mounted, and which directory of the image is its base. */
  readonly path: string;
  /**
   * Snapshots kept per session (each one an `undo` step); older ones are
   * garbage collected. @default all
   */
  readonly history?: number;
  readonly machine?: {
    /** A Cloudflare container's instance type. @default "standard-1" */
    readonly instanceType?: ContainerInstanceType;
    /** Stop a machine this long after its last command. @default "5 minutes" */
    readonly idle?: Duration.Input;
    /**
     * Run machines on AWS Lambda MicroVMs instead of Cloudflare containers
     * (the sessions stay on Cloudflare). Each machine's blockd reads and
     * writes its head and journal in the bucket directly, so `fsync` is
     * slower than on a container. Needs the AWS providers on the stack.
     */
    readonly lambda?: {
      readonly memory: MicrovmSandboxMemory;
      readonly cpuConfigurations?: microvms.CpuConfiguration[];
    };
  };
}

/**
 * Host a `Sandbox.Workspace` on Cloudflare: sessions' disks in an R2
 * bucket, built from `path` in the image `dockerfile` builds, and mounted on
 * a container running that image while an `open` runs. Deploys a Worker of
 * its own with a Durable Object per session (its head and its running
 * opens) and per machine (its container). Every Worker or Durable Object
 * that yields the workspace reaches them through bindings. Returns the Layer
 * that satisfies `yield* Workspace`: provide it on the stack. The images
 * build with Docker, so the stack's providers need `DockerLive`.
 *
 * ### Hosting a workspace
 * **Example:** A Node workspace with the repository checked out
 * ```typescript
 * // src/Workspace.cloudflare.ts
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import { Workspace } from "./Workspace.ts";
 *
 * export default Cloudflare.Containers.Workspace(Workspace, {
 *   size: "16 GB",
 *   dockerfile: `FROM node:24-bookworm
 * RUN git clone --depth 1 https://github.com/alchemy-run/alchemy /workspace && cd /workspace && npm ci`,
 *   path: "/workspace",
 *   machine: { instanceType: "standard-2", idle: "10 minutes" },
 * });
 * ```
 *
 * ### Machines on Lambda MicroVMs
 * Sessions stay on Cloudflare; each session's machine is an AWS Lambda
 * MicroVM. The stack needs the AWS providers too.
 *
 * **Example:** MicroVM machines
 * ```typescript
 * // src/Workspace.cloudflare.ts
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import { Workspace } from "./Workspace.ts";
 *
 * export default Cloudflare.Containers.Workspace(Workspace, {
 *   dockerfile: `FROM node:24-bookworm
 * RUN mkdir -p /workspace`,
 *   path: "/workspace",
 *   machine: {
 *     idle: "5 minutes",
 *     lambda: { memory: "4 GB", cpuConfigurations: [{ architecture: "ARM_64" }] },
 *   },
 * });
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const Workspace = <const D extends SandboxWorkspace.Decl.Any>(
  workspace: D,
  props: WorkspaceProps,
): Layer.Layer<SandboxWorkspace.Host<SelfOf<D>>, never, Providers> => {
  const id = workspace.LogicalId;
  const config: HostConfig = {
    id,
    path: props.path,
    instanceType: props.machine?.instanceType ?? "standard-1",
    idleMs: Duration.toMillis(Duration.fromInputUnsafe(props.machine?.idle ?? "5 minutes")),
    machine: props.machine?.lambda ? "lambda" : "container",
    ...(props.history !== undefined ? { history: props.history } : {}),
  };
  const lambda = props.machine?.lambda;
  // A MicroVM machine is a sandbox: its host builds the image (the
  // workspace's Dockerfile, blockd, and the capabilities to mount).
  const machines = lambda
    ? machineHost(
        {
          id,
          memory: lambda.memory,
          ...(lambda.cpuConfigurations ? { cpuConfigurations: lambda.cpuConfigurations } : {}),
        },
        {
          main: new URL(`./WorkspaceMachine${extensionOf(import.meta.url)}`, import.meta.url).href,
          dockerfile: props.dockerfile,
        },
      )
    : Layer.empty;
  const volume = R2Volume(volumeOf(id), {
    ...(props.size !== undefined ? { size: props.size } : {}),
    base: { dockerfile: props.dockerfile, path: props.path },
  });
  return Layer.effect(
    workspaceHost(id),
    Effect.gen(function* () {
      // The host Worker gets the volume's host and the machine's sandbox
      // host, and nothing else: a platform's own services (a MicroVM image's
      // binding host, say) must not leak into the Worker's.
      const volumeService = yield* volumeHost(id);
      const machineId = machineSandbox(id).LogicalId;
      const machineService = lambda ? yield* sandboxHost(machineId) : undefined;
      const token = yield* Random(`${id}WorkspaceToken`, { bytes: 32 });
      const host = yield* hostWorker(config, {
        main: new URL(`./WorkspaceHost${extensionOf(import.meta.url)}`, import.meta.url).href,
        dockerfile: props.dockerfile,
        token: token.text,
        provide: (effect) => {
          const withVolume = Effect.provideService(effect, volumeHost(id), volumeService);
          return machineService
            ? Effect.provideService(withVolume, sandboxHost(machineId), machineService)
            : withVolume;
        },
      }) as unknown as Effect.Effect<Worker, never, Providers>;
      return {
        descriptor: Output.all(host.workerName, host.url).pipe(
          Output.map(([script, url]): WorkspaceHostDescriptor => ({
            host: WORKSPACE_HOST,
            script,
            id,
            ...(url ? { url } : {}),
          })),
        ),
        // The yielding Worker binds the host's Durable Objects.
        bind: Effect.gen(function* () {
          const yielding = yield* CoreBinding.Host;
          if (!yielding || !isWorker(yielding)) return;
          // `.from` takes the Worker (an Effect of it): its script name is an
          // Output until deploy.
          yield* sessionObject(id).from(Effect.succeed(host) as never);
          yield* machineObject(id).from(Effect.succeed(host) as never);
        }),
      } satisfies WorkspaceHostService;
    }).pipe(Effect.provide(Layer.merge(volume, machines))),
  ) as unknown as Layer.Layer<SandboxWorkspace.Host<SelfOf<D>>, never, Providers>;
};

const extensionOf = (url: string) => (url.endsWith(".ts") ? ".ts" : ".js");

type SelfOf<D> = D extends SandboxWorkspace.Decl<infer Self, any> ? Self : never;
