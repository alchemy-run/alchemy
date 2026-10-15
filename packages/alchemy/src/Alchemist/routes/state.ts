import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  | ({ readonly backend: string } & Pick<Target, "profile" | "envFile">)
  /** Whatever the project's entrypoint configures. */
  | ({ readonly backend: "configured" } & Target);

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
    const { profile, envFile } = source as Pick<Target, "profile" | "envFile">;
    const stores = yield* Plugin.stateStores();
    const backend = stores.get(source.backend);
    if (backend === undefined) {
      return yield* new Plugin.PluginError({
        message: `Unknown state backend '${source.backend}'. Available: local, configured${[
          ...stores.keys(),
        ]
          .map((name) => `, ${name}`)
          .join("")}.`,
      });
    }
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
      Effect.provide(layer),
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
