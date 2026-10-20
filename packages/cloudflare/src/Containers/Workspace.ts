import type {
  Workspace as SandboxWorkspace,
  WorkspaceHostService,
} from "@alchemy.run/sandbox/Workspace";
import { workspaceHost } from "@alchemy.run/sandbox/Workspace";
import * as CoreBinding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Providers } from "../Providers.ts";
import { Volume as R2Volume } from "../R2/Volume.ts";
import { isWorker, type Worker } from "../Workers/Worker.ts";
import type { ContainerInstanceType } from "./SandboxClient.ts";
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
  readonly machine?: {
    /** @default "standard-1" */
    readonly instanceType?: ContainerInstanceType;
    /** Stop a machine this long after its last command. @default "5 minutes" */
    readonly idle?: Duration.Input;
  };
}

/**
 * Host a `Sandbox.Workspace` on Cloudflare: sessions' disks in an R2
 * bucket, built from `path` in the image `dockerfile` builds, and mounted on
 * a container running that image while an `open` runs. Deploys a Worker of
 * its own with a Durable Object per session (its head and its running
 * opens) and per machine (its container). Every Worker or Durable Object
 * that yields the workspace reaches them through bindings. Returns the Layer
 * that satisfies `yield* Workspace`: provide it on the stack.
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
  };
  const volume = R2Volume(volumeOf(id), {
    ...(props.size !== undefined ? { size: props.size } : {}),
    base: { dockerfile: props.dockerfile, path: props.path },
  });
  return Layer.effect(
    workspaceHost(id),
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      // The host Worker's own requirements (the volume's host, its machine's
      // image) are satisfied here, by this Layer's context.
      const host = yield* hostWorker(config, {
        main: new URL(`./WorkspaceHost${extensionOf(import.meta.url)}`, import.meta.url).href,
        dockerfile: props.dockerfile,
        provide: (effect) => Effect.provide(effect, context),
      }) as unknown as Effect.Effect<Worker, never, Providers>;
      return {
        descriptor: host.workerName.pipe(
          Output.map((script): WorkspaceHostDescriptor => ({ host: WORKSPACE_HOST, script, id })),
        ),
        // The yielding Worker binds the host's Durable Objects.
        bind: Effect.gen(function* () {
          const yielding = yield* CoreBinding.Host;
          if (!yielding || !isWorker(yielding)) return;
          yield* sessionObject(id).from(host.workerName);
          yield* machineObject(id).from(host.workerName);
        }),
      } satisfies WorkspaceHostService;
    }).pipe(Effect.provide(volume)),
  ) as unknown as Layer.Layer<SandboxWorkspace.Host<SelfOf<D>>, never, Providers>;
};

const extensionOf = (url: string) => (url.endsWith(".ts") ? ".ts" : ".js");

type SelfOf<D> = D extends SandboxWorkspace.Decl<infer Self, any> ? Self : never;
