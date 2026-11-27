/**
 * Shared local storage across runtimes.
 *
 * `alchemy dev` runs every Worker in a workerd process of its own, all over
 * one storage directory. The storage simulators (D1, R2, KV, the Images
 * store, Secrets Store, Stream) keep their data in Durable Object SQLite
 * files under that directory, and SQLite cannot serve writers in several
 * processes: concurrent writes fail with `SQLITE_BUSY`, and workerd aborts
 * when it finds a namespace's `metadata.sqlite` locked.
 *
 * So one runtime owns each storage directory, and every runtime reaches the
 * simulators through it (Miniflare's shared storage,
 * `workers-sdk/packages/miniflare/src/plugins/shared/index.ts`
 * `getStorageService`):
 *
 * - every runtime that binds shared storage registers as a candidate owner
 *   in the dev registry, and hosts every storage simulator, so it can take
 *   over when the owner stops;
 * - the oldest live candidate owns the directory;
 * - storage bindings target the registry proxy's `ExternalStorage`
 *   entrypoint, which forwards to the simulator on the owner;
 * - runtimes hosting the simulators boot one at a time per directory, since
 *   workerd opens their `metadata.sqlite` files while it starts.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Storage from "../globals/Storage.ts";
import { canonicalizeDirectory } from "../internal/StartupLock.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";
import { RegistryProxy } from "./RegistryProxy.ts";

/**
 * Whether runtimes share storage through an elected owner. On by default;
 * turn it off (`Layer.succeed(SharedStorageEnabled, false)`) to have every
 * runtime open the storage directory itself.
 */
export const SharedStorageEnabled = Context.Reference<boolean>(
  "cloudflare-runtime/SharedStorageEnabled",
  { defaultValue: () => true },
);

/** Options for routing a storage simulator service. */
export interface RouteOptions {
  /** See `StorageTarget.rpcProperties`. */
  readonly rpcProperties?: ReadonlyArray<string>;
}

export class SharedStorage extends Plugin.Service<
  SharedStorage,
  {
    /**
     * Resolve the designator a binding should use to reach a storage
     * simulator: through the storage owner when storage is shared, the local
     * service otherwise. Must be called while binding hooks run, before the
     * plugins' `defer`.
     */
    readonly route: (
      service: WorkerdConfig.ServiceDesignator,
      options?: RouteOptions,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
    /**
     * Whether this runtime is a candidate storage owner and so must host
     * every storage simulator, bound or not. Final once binding hooks ran.
     */
    readonly hosting: Effect.Effect<boolean>;
  }
>()("cloudflare-runtime/plugin/SharedStorage") {}

export const SharedStorageLive = Layer.effect(
  SharedStorage,
  Effect.gen(function* () {
    const enabled = yield* SharedStorageEnabled;
    const storage = yield* Storage.Storage;
    const diskPath = "disk" in storage ? storage.disk?.path : undefined;
    const scope =
      enabled && diskPath !== undefined
        ? yield* canonicalizeDirectory(diskPath).pipe(Effect.orElseSucceed(() => undefined))
        : undefined;

    return SharedStorage.of(
      Effect.gen(function* () {
        const context = yield* PluginContext;
        let hosting = false;
        return {
          api: {
            route: (service, options) =>
              scope === undefined || service.name === undefined
                ? Effect.succeed(service)
                : context.get(RegistryProxy).pipe(
                    Effect.flatMap((proxy) =>
                      proxy.api.storage({
                        scope,
                        service: service.name!,
                        entrypoint: service.entrypoint,
                        props: service.props ? JSON.parse(service.props.json) : undefined,
                        rpcProperties: options?.rpcProperties,
                      }),
                    ),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        hosting = true;
                      }),
                    ),
                    // No registry proxy in this runtime: storage stays local.
                    Effect.orElseSucceed(() => service),
                  ),
            hosting: Effect.sync(() => hosting),
          },
          defer: Effect.sync(() =>
            hosting && scope !== undefined ? { startupLocks: [scope] } : {},
          ),
        };
      }),
    );
  }),
);

/**
 * Route a storage simulator service through the storage owner (see
 * {@link SharedStorage}); falls back to the local service when the runtime
 * has no `SharedStorage` plugin.
 */
export const route = (
  service: WorkerdConfig.ServiceDesignator,
  options?: RouteOptions,
): Effect.Effect<WorkerdConfig.ServiceDesignator, never, PluginContext> =>
  PluginContext.use((context) =>
    context.get(SharedStorage).pipe(
      Effect.flatMap((plugin) => plugin.api.route(service, options)),
      Effect.orElseSucceed(() => service),
    ),
  );

/**
 * Whether the current runtime hosts every storage simulator as a candidate
 * owner (see {@link SharedStorage}). Use from a plugin's `defer`.
 */
export const hosting: Effect.Effect<boolean, never, PluginContext> = PluginContext.use((context) =>
  context.get(SharedStorage).pipe(
    Effect.flatMap((plugin) => plugin.api.hosting),
    Effect.orElseSucceed(() => false),
  ),
);
