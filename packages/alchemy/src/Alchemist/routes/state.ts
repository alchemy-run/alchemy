import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Resolve.ts";
import * as Contributions from "../../Contributions.ts";
import * as State from "../../State/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { open, StackEntrypointError, type Target } from "../Session.ts";

/**
 * Build a provider's layers from scratch: the process may already have built
 * them (credentials, auth registration) for another profile, and layers are
 * memoized process-wide.
 */
const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideServiceEffect(effect, Layer.CurrentMemoMap, Layer.makeMemoMap);

/** Which store a state request addresses. */
export type StateSource =
  /** `.alchemy/` on this machine, ignoring whatever the project configures. */
  | { readonly _tag: "Local" }
  /** Whatever the project's entrypoint configures. */
  | ({ readonly _tag: "Configured" } & Target)
  /** A provider's state store, without loading a project entrypoint. */
  | ({
      readonly _tag: "Provider";
      readonly backend: string;
      /** A store other than the account's default. */
      readonly name?: string;
    } & Pick<Target, "profile" | "envFile">);

/** What lifecycle operations act on. */
export type ProviderSource = Extract<StateSource, { readonly _tag: "Provider" }>;

/** A provider's state store by `--backend` name. */
const findBackend = Effect.fn(function* (backend: string) {
  const stores = yield* Contributions.stateStores();
  const store = stores.get(backend);
  if (store === undefined) {
    return yield* new Contributions.ContributionError({
      message: `Unknown state backend '${backend}'. Available: local, configured${[...stores.keys()]
        .map((name) => `, ${name}`)
        .join("")}.`,
    });
  }
  return store;
});

/**
 * What a provider's store runs under, its layer and lifecycle alike: the
 * profile's config and an auth registry with the provider's auth.
 *
 * @internal exported for tests.
 */
export const providerContext = Effect.fn(function* (
  provider: Contributions.Contributions,
  target: Pick<Target, "profile" | "envFile">,
) {
  const config = ConfigProvider.layer(
    withProfileOverride(
      yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
      target.profile,
    ),
  );
  const auth = provider.auth
    ? yield* Contributions.resolve(provider, "auth", provider.auth)
    : Layer.empty;
  return auth.pipe(
    Layer.provideMerge(Layer.succeed(AuthProviders, {} satisfies AuthProviders["Service"])),
    Layer.provideMerge(config),
  );
});

/**
 * Resolve the state service a source addresses, in the caller's `Scope`: the
 * store's resources live until that scope closes. The tree operations
 * (`State.listState`, `State.readState`, `State.deleteState`) take `State`
 * from context — provide the resolved service (or {@link layer}) to run
 * them against the chosen store:
 *
 * ```ts
 * const state = yield* Alchemist.State.store({ _tag: "Local" });
 * const items = yield* State.listState({ path }).pipe(
 *   Effect.provideService(State.State, Effect.succeed(state)),
 * );
 * ```
 */
export const store = Effect.fn("Alchemist.state.store")(function* (source: StateSource) {
  switch (source._tag) {
    case "Local":
      return yield* Effect.provide(
        Effect.flatten(State.State),
        yield* Layer.build(State.localState()),
      );
    case "Provider": {
      const { provider, store } = yield* findBackend(source.backend);
      const { layer } = yield* store.load;
      const context = yield* Layer.build(
        layer({ name: source.name }).pipe(Layer.provide(yield* providerContext(provider, source))),
      ).pipe(isolated);
      return yield* Effect.provide(Effect.flatten(State.State), context);
    }
    case "Configured": {
      // The configured store lives in the stack entrypoint; this is the one
      // command that can also work without one.
      const session = yield* open(source).pipe(
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
    }
  }
});

/** The chosen store as a `State` layer. */
export const layer = (source: StateSource) =>
  Layer.effect(State.State, Effect.map(store(source), Effect.succeed));

/** A provider store's lifecycle operation, with the context to run it under. */
const lifecycleOperation = Effect.fn(function* <K extends keyof Contributions.StateStoreLifecycle>(
  source: ProviderSource,
  operation: K,
) {
  if (Contributions.RESERVED_BACKENDS.includes(source.backend)) {
    return yield* new Contributions.ContributionError({
      message: `The ${source.backend} state store has no ${operation}; pass --backend with a provider's store.`,
    });
  }
  const { provider, store } = yield* findBackend(source.backend);
  const run = (yield* store.load).lifecycle?.[operation];
  if (run === undefined) {
    return yield* new Contributions.ContributionError({
      message: `State backend '${source.backend}' does not support ${operation}.`,
    });
  }
  return {
    run,
    context: yield* providerContext(provider, source),
  };
});

/** Provision (or adopt) a state store. */
export const bootstrap = Effect.fn("Alchemist.state.bootstrap")(function* (
  source: ProviderSource & { readonly force?: boolean },
) {
  const { run, context } = yield* lifecycleOperation(source, "bootstrap");
  return yield* run({ name: source.name, force: source.force }).pipe(
    Effect.provide(context),
    isolated,
  );
});

/** Delete a state store and its backing resources. */
export const teardown = Effect.fn("Alchemist.state.teardown")(function* (source: ProviderSource) {
  const { run, context } = yield* lifecycleOperation(source, "teardown");
  return yield* run({ name: source.name }).pipe(Effect.provide(context), isolated);
});

/** Past log entries from a state store, oldest first. */
export const logs = Effect.fn("Alchemist.state.logs")(function* (
  source: ProviderSource & { readonly limit?: number; readonly since?: Date },
) {
  const { run, context } = yield* lifecycleOperation(source, "logs");
  return yield* run({ name: source.name, limit: source.limit, since: source.since }).pipe(
    Effect.provide(context),
    isolated,
  );
});

/** Live log entries from a state store. */
export const tailLogs = (source: ProviderSource) =>
  Stream.unwrap(
    Effect.map(lifecycleOperation(source, "tailLogs"), ({ run, context }) =>
      run({ name: source.name }).pipe(
        Stream.provide(context),
        Stream.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
      ),
    ),
  );
