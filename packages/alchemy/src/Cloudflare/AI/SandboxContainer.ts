import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Sandbox,
  type SandboxEntry,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "../../AI/Sandbox.ts";
import {
  Container,
  type ContainerStartupOptions,
} from "../Containers/Container.ts";
import { layer as containerLayer } from "../Containers/StartContainer.ts";
import type { Providers } from "../Providers.ts";

/**
 * The typed RPC surface the sandbox container guest serves — a 1:1
 * mirror of the {@link Sandbox} contract, so the started container
 * instance satisfies the seam directly.
 */
export interface SandboxContainerShape {
  readonly exec: (
    command: string,
    args?: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ) => Effect.Effect<SandboxExecResult, string>;
  readonly readFile: (path: string) => Effect.Effect<string, string>;
  readonly writeFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, string>;
  readonly deleteFile: (path: string) => Effect.Effect<void, string>;
  readonly mkdir: (path: string) => Effect.Effect<void, string>;
  readonly listFiles: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>;
  readonly exists: (path: string) => Effect.Effect<boolean, string>;
}

/**
 * The sandbox container image declaration — the tag a Durable Object
 * imports to reach the machine. Only the class lives here (Container
 * Layer pattern): the runtime implementation is the default export of
 * `SandboxContainerRuntime.ts`, which must be provided on the Stack so
 * the image is built and deployed:
 *
 * ```ts
 * // alchemy.run.ts
 * import SandboxContainerRuntime from "alchemy/Cloudflare/AI/SandboxContainerRuntime";
 *
 * Alchemy.Stack("Org", config, program.pipe(
 *   Effect.provide(SandboxContainerRuntime),
 * ));
 * ```
 */
export class SandboxContainerImage extends Container<
  SandboxContainerImage,
  SandboxContainerShape
>()("SandboxContainer") {}

/**
 * The PER-SESSION Cloudflare Container {@link Sandbox}: sessions map
 * 1:1 to Durable Object instances (`DriverCloudflare`), and a
 * container attaches to its Durable Object — so providing this layer
 * on the session host gives every session its own machine, started on
 * first use and recycled after idle (`sleepAfter`). The container's
 * disk is EPHEMERAL: work that must outlive the instance leaves
 * through git (push) or an explicit persistence mount, not the local
 * filesystem.
 *
 * ```ts
 * // in the charter / session host provide-list, replacing SandboxLocal
 * Effect.provide(Cloudflare.SandboxContainer())
 * ```
 */
export const SandboxContainer = (
  options?: ContainerStartupOptions,
): Layer.Layer<
  Sandbox,
  never,
  // satisfied by the Stack: the runtime `.make()` Layer provides the
  // Application; Providers are ambient in every stack program
  Container.Application<SandboxContainerImage> | Providers
> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const box = yield* SandboxContainerImage;
      return {
        exec: (command, args, execOptions) =>
          box.exec(command, args, execOptions),
        readFile: (path) => box.readFile(path),
        writeFile: (path, content) => box.writeFile(path, content),
        deleteFile: (path) => box.deleteFile(path),
        mkdir: (path) => box.mkdir(path),
        listFiles: (path) => box.listFiles(path),
        exists: (path) => box.exists(path),
      };
    }),
  ).pipe(Layer.provide(containerLayer(SandboxContainerImage, options)));
