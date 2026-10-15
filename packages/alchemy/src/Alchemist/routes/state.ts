import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Resolve.ts";
import * as Plugin from "../../Plugin.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { open, StackEntrypointError, type Target } from "../Session.ts";

/** Which store a state request addresses. */
export type StateSource =
  /** `.alchemy/` on this machine, ignoring whatever the project configures. */
  | { readonly backend: "local" }
  /**
   * A plugin's state store by name (e.g. `"aws"`, `"cloudflare"`), without
   * loading a project entrypoint.
   */
  | ({ readonly backend: string } & Plugin.StateStoreTarget)
  /** Whatever the project's entrypoint configures. */
  | ({ readonly backend: "configured" } & Target);

/**
 * A plugin's state store by `--backend` name, checking it can address the
 * named store when one is given.
 */
const findBackend = Effect.fn(function* (backend: string, name?: string) {
  const stores = yield* Plugin.stateStores();
  const store = stores.get(backend);
  if (store === undefined) {
    return yield* new Plugin.PluginError({
      message: `Unknown state backend '${backend}'. Available: local, configured${[...stores.keys()]
        .map((store) => `, ${store}`)
        .join("")}.`,
    });
  }
  if (name !== undefined && !store.supportsNames) {
    return yield* new Plugin.PluginError({
      message: `State backend '${backend}' has only the default store; it does not take a name.`,
    });
  }
  return store;
});

/**
 * Resolve the state service a source addresses. The tree operations
 * (`State.listState`, `State.readState`, `State.deleteState`) take `State`
 * from context — provide the resolved service (or {@link layer}) to run
 * them against the chosen store:
 *
 * ```ts
 * const state = yield* Alchemist.State.store({ backend: "local" });
 * const items = yield* State.listState({ path }).pipe(
 *   Effect.provideService(State.State, Effect.succeed(state)),
 * );
 * ```
 */
export const store = Effect.fn("Alchemist.state.store")(function* (source: StateSource) {
  if (source.backend === "local") {
    return yield* Effect.provide(Effect.flatten(State.State), State.localState());
  }
  if (source.backend !== "configured") {
    const { name, profile, envFile } = source as Plugin.StateStoreTarget;
    const backend = yield* findBackend(source.backend, name);
    const config = ConfigProvider.layer(
      withProfileOverride(yield* loadConfigProvider(Option.fromNullishOr(envFile)), profile),
    );
    const layer = yield* Effect.tryPromise({
      try: backend.layer,
      catch: (cause) =>
        new Plugin.PluginError({
          message: `Could not load state backend '${source.backend}'`,
          cause,
        }),
    });
    return yield* Effect.flatten(State.State).pipe(
      Effect.provide(layer({ name })),
      Effect.provide(Layer.succeed(AuthProviders, {} satisfies AuthProviders["Service"])),
      Effect.provide(config),
    );
  }
  // The configured store lives in the stack entrypoint; this is the one
  // command that can also work without one.
  const session = yield* open(source as Target).pipe(
    Effect.catchIf(
      (error): error is StackEntrypointError => error instanceof StackEntrypointError,
      (error) =>
        Effect.fail(
          new StackEntrypointError({
            message: `${error.message} For config-less state access pass --backend with a state store name.`,
          }),
        ),
    ),
  );
  return yield* Effect.provide(Effect.flatten(State.State), session.context);
});

/** The chosen store as a `State` layer. */
export const layer = (source: StateSource) =>
  Layer.effect(State.State, Effect.map(store(source), Effect.succeed));

/** Which plugin state store a lifecycle request addresses. */
export interface LifecycleTarget extends Plugin.StateStoreTarget {
  /** A plugin state store's `--backend` name, e.g. `"cloudflare"`. */
  readonly backend: string;
}

const lifecycleOperation = <K extends keyof Plugin.StateStoreLifecycle>(
  { backend, name }: LifecycleTarget,
  operation: K,
) =>
  Effect.gen(function* () {
    const store = yield* findBackend(backend, name);
    const lifecycle = store.lifecycle
      ? yield* Effect.tryPromise({
          try: store.lifecycle,
          catch: (cause) =>
            new Plugin.PluginError({
              message: `Could not load the lifecycle of state backend '${backend}'`,
              cause,
            }),
        })
      : undefined;
    const run = lifecycle?.[operation];
    if (run === undefined) {
      return yield* new Plugin.PluginError({
        message: `State backend '${backend}' does not support ${operation}.`,
      });
    }
    return run as NonNullable<Plugin.StateStoreLifecycle[K]>;
  });

/** Provision (or adopt) a plugin's state store. */
export const bootstrap = Effect.fn("Alchemist.state.bootstrap")(function* ({
  backend,
  ...input
}: LifecycleTarget & { readonly force?: boolean }) {
  return yield* (yield* lifecycleOperation({ backend, ...input }, "bootstrap"))(input);
});

/** Delete a plugin's state store and its backing resources. */
export const teardown = Effect.fn("Alchemist.state.teardown")(function* ({
  backend,
  ...input
}: LifecycleTarget) {
  return yield* (yield* lifecycleOperation({ backend, ...input }, "teardown"))(input);
});

/** Past log entries from a plugin's state store, oldest first. */
export const logs = Effect.fn("Alchemist.state.logs")(function* ({
  backend,
  ...input
}: LifecycleTarget & { readonly limit?: number; readonly since?: Date }) {
  return yield* (yield* lifecycleOperation({ backend, ...input }, "logs"))(input);
});

/** Live log entries from a plugin's state store. */
export const tailLogs = ({ backend, ...input }: LifecycleTarget) =>
  Stream.unwrap(
    Effect.map(lifecycleOperation({ backend, ...input }, "tailLogs"), (tail) => tail(input)),
  );
