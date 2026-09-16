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
import {
  layer as containerLayer,
  startContainer,
} from "../Containers/StartContainer.ts";
import type { Providers } from "../Providers.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";

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
 * Alchemy.Stack("Org", config, program.pipe(
 *   Effect.provide(Cloudflare.AI.SandboxContainerRuntime),
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

/** One started container stub per DO instance — the isolate is
 *  single-threaded, so a plain WeakMap gate is race-free. */
const sessionBoxes = new WeakMap<
  object,
  Effect.Effect<Container.Instance<SandboxContainerImage>>
>();

/**
 * The DEFERRED per-session container {@link Sandbox} — for layers that
 * build in the SHARED per-isolate graph (a charter's tool layers under
 * `DriverCloudflare`), where no `DurableObjectState` exists at build:
 * the container is resolved and started at CALL time from the session
 * context (the session DO adds its own state — see
 * `DriverCloudflare`), memoized per instance.
 *
 * Same contract, same machine as {@link SandboxContainer}; the only
 * difference is WHEN the instance binds — build time (a layer inside
 * one DO) vs call time (a layer shared by every session of the
 * isolate).
 *
 * ```ts
 * // in the org's charter provide-list, replacing SandboxLocal:
 * Layer.provide(Cloudflare.AI.SandboxContainerSession())
 * ```
 */
export const SandboxContainerSession = (
  options?: ContainerStartupOptions,
): Layer.Layer<
  Sandbox,
  never,
  Container.Application<SandboxContainerImage> | Providers
> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      // capture the build context (the container binding + providers)
      // so the call-time start needs only the session's own state
      const captured = yield* Effect.context<
        Container.Application<SandboxContainerImage> | Providers
      >();

      const box = Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const existing = sessionBoxes.get(state);
        if (existing !== undefined) return yield* existing;
        const started = Effect.cached(
          startContainer(SandboxContainerImage, options).pipe(
            Effect.provide(captured),
            Effect.orDie,
          ) as Effect.Effect<Container.Instance<SandboxContainerImage>>,
        ).pipe(Effect.runSync);
        sessionBoxes.set(state, started);
        return yield* started;
      });

      // the session context carries DurableObjectState at call time
      // (the DO placement provides it); the contract's R stays clean
      const withBox = <A, E>(
        use: (
          instance: Container.Instance<SandboxContainerImage>,
        ) => Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.flatMap(box, use) as unknown as Effect.Effect<A, E>;

      return {
        exec: (command, args, execOptions) =>
          withBox((instance) => instance.exec(command, args, execOptions)),
        readFile: (path) => withBox((instance) => instance.readFile(path)),
        writeFile: (path, content) =>
          withBox((instance) => instance.writeFile(path, content)),
        deleteFile: (path) => withBox((instance) => instance.deleteFile(path)),
        mkdir: (path) => withBox((instance) => instance.mkdir(path)),
        listFiles: (path) => withBox((instance) => instance.listFiles(path)),
        exists: (path) => withBox((instance) => instance.exists(path)),
      };
    }),
  );
