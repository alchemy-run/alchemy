import type * as Command from "effect/cli/Command";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { LogEntry } from "./Alchemist/routes/logs.ts";
import type { Services } from "./Alchemist/Runtime.ts";
import type { State } from "./State/State.ts";
import { UserFacingError } from "./UserFacingError.ts";

/**
 * What a provider contributes to Alchemy outside a stack: the parts the CLI,
 * the Alchemist API and the test harness need before (or without) importing
 * the user's `alchemy.run.ts`.
 *
 * A plugin module is imported on every CLI start, so it holds metadata and
 * lazy `import()`s only; the provider's code loads when a field is used.
 *
 * A package declares its plugins in `package.json`:
 *
 * ```json
 * { "alchemy": { "plugins": ["@alchemy.run/aws/Plugin"] } }
 * ```
 *
 * {@link load} reads that field from `alchemy` itself and from the project's
 * dependencies.
 */
export interface Plugin {
  /** Unique across loaded plugins, e.g. `"aws"`. */
  readonly name: string;
  /**
   * Registers the provider's `AuthProvider` into `AuthProviders`, so
   * `alchemy profile` and login work without a stack that uses the provider.
   */
  readonly auth?: Lazy<Layer.Layer<never, never, any>>;
  /**
   * State stores reachable from a profile alone, keyed by the name
   * `alchemy state --backend <name>` addresses them by.
   */
  readonly stateStores?: Readonly<Record<string, StateStore>>;
  /** CLI commands the provider adds. */
  readonly cli?: Cli;
  /**
   * Services the test harness runs tests under when `ALCHEMY_TEST_DEV` is
   * set, e.g. a local emulator for the provider's SDK clients.
   */
  readonly testServices?: Lazy<TestServices>;
}

type Lazy<A> = () => Promise<A>;

export interface StateStore {
  readonly description: string;
  /**
   * The store's `State` layer. Built under the requested profile's config
   * with an `AuthProviders` registry in context.
   */
  readonly layer: Lazy<Layer.Layer<State, any, any>>;
  /**
   * Provisioning for a store that is infrastructure of its own, such as
   * Cloudflare's state-store Worker. Omit it for a store that needs none,
   * like AWS's S3 store, which creates its bucket on first use.
   */
  readonly lifecycle?: Lazy<StateStoreLifecycle>;
}

/** Which profile and `.env` a state-store operation acts under. */
export interface StateStoreTarget {
  /** Falls back to the active profile. */
  readonly profile?: string;
  readonly envFile?: string;
}

export interface StateStoreLifecycle {
  /** Provision the store, or adopt it when it exists. Idempotent. */
  readonly bootstrap?: (
    input: StateStoreTarget & {
      /** Redeploy an existing store instead of adopting it. */
      readonly force?: boolean;
    },
  ) => Effect.Effect<StateStoreBootstrap, StateStoreLifecycleError, Services>;
  /** Delete the store and its backing resources. Idempotent. */
  readonly teardown?: (
    input: StateStoreTarget,
  ) => Effect.Effect<StateStoreTeardown, StateStoreLifecycleError, Services>;
  /** The store's past log entries, oldest first. */
  readonly logs?: (
    input: StateStoreTarget & { readonly limit?: number; readonly since?: Date },
  ) => Effect.Effect<ReadonlyArray<LogEntry>, StateStoreLifecycleError, Services>;
  /** The store's log entries as they happen. */
  readonly tailLogs?: (
    input: StateStoreTarget,
  ) => Stream.Stream<LogEntry, StateStoreLifecycleError, Services>;
}

export interface StateStoreBootstrap {
  readonly status: "created" | "adopted" | "redeployed";
  /** One line for the user, e.g. which Worker in which account. */
  readonly summary: string;
}

export interface StateStoreTeardown {
  /** What was deleted, e.g. Worker names. */
  readonly deleted: ReadonlyArray<string>;
}

/** Lifecycle errors are the store's own; any tagged error will do. */
export type StateStoreLifecycleError = { readonly _tag: string };

export interface Cli {
  /** A subcommand of `alchemy provider`, named after the provider. */
  readonly provider?: Lazy<AnyCommand>;
}

// Any command, whatever its name, errors and the CLI services it runs under.
export type AnyCommand = Command.Command<any, any, any, any, any>;

export interface TestServices {
  /** Provided to test bodies and stack programs, closest wins. */
  readonly layer: Layer.Layer<any, any, never>;
  /** Rewrites the test's outbound HTTP, e.g. onto the emulator's gateway. */
  readonly mapRequest?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
  /** Set on the test process before anything forks, unless already set. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Declare a plugin; the identity function, for inference. */
export const make = (plugin: Plugin): Plugin => plugin;

export class PluginError extends Data.TaggedError("PluginError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

const Manifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  alchemy: Schema.optional(
    Schema.Struct({ plugins: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

const readManifest = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return undefined;
  const text = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new PluginError({ message: `Invalid JSON in ${file}`, cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
    Effect.mapError(
      (cause) => new PluginError({ message: `Invalid package manifest ${file}`, cause }),
    ),
  );
});

/** Find `node_modules/<name>/package.json` from `dir` upwards. */
const findDependencyManifest = Effect.fn(function* (dir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = dir;
  while (true) {
    const candidate = path.join(current, "node_modules", name, "package.json");
    if (yield* fs.exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});

const importPlugin = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<{ readonly default?: unknown }>,
    catch: (cause) => new PluginError({ message: `Could not import plugin ${specifier}`, cause }),
  }).pipe(
    Effect.flatMap((module) =>
      typeof module.default === "object" &&
      module.default !== null &&
      typeof (module.default as Plugin).name === "string"
        ? Effect.succeed(module.default as Plugin)
        : Effect.fail(
            new PluginError({ message: `Plugin ${specifier} has no default-exported plugin` }),
          ),
    ),
  );

const discover = Effect.fn("Plugin.discover")(function* (cwd: string) {
  const path = yield* Path.Path;
  const specifiers = new Set<string>();
  // alchemy's own: the providers that still live in this package.
  const own = yield* readManifest(
    yield* path.fromFileUrl(new URL("../package.json", import.meta.url)),
  );
  for (const specifier of own?.alchemy?.plugins ?? []) specifiers.add(specifier);
  // The project's dependencies that declare plugins.
  const project = yield* readManifest(path.join(cwd, "package.json"));
  const dependencies = Object.keys({
    ...project?.dependencies,
    ...project?.devDependencies,
  }).filter((name) => name !== own?.name);
  for (const name of dependencies) {
    const file = yield* findDependencyManifest(cwd, name);
    if (file === undefined) continue;
    const manifest = yield* readManifest(file);
    for (const specifier of manifest?.alchemy?.plugins ?? []) specifiers.add(specifier);
  }
  const plugins = yield* Effect.forEach(specifiers, importPlugin, { concurrency: "unbounded" });
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      return yield* new PluginError({ message: `Two plugins are named ${plugin.name}` });
    }
    seen.add(plugin.name);
  }
  return plugins;
});

const loaded = new Map<string, Effect.Effect<ReadonlyArray<Plugin>, PluginError>>();

/** The plugins reachable from the project in `cwd`, loaded once per process. */
export const load = Effect.fn("Plugin.load")(function* (cwd?: string) {
  const dir = cwd ?? (yield* Effect.sync(() => process.cwd()));
  let cached = loaded.get(dir);
  if (cached === undefined) {
    cached = yield* Effect.cached(
      discover(dir).pipe(
        Effect.mapError((error) =>
          error._tag === "PluginError"
            ? error
            : new PluginError({ message: "Could not read package manifests", cause: error }),
        ),
        Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
        Effect.provideService(Path.Path, yield* Path.Path),
      ),
    );
    loaded.set(dir, cached);
  }
  return yield* cached;
});

/** Every plugin's state stores, by `--backend` name. */
export const stateStores = Effect.fn("Plugin.stateStores")(function* () {
  const stores = new Map<string, StateStore>();
  for (const plugin of yield* load()) {
    for (const [name, store] of Object.entries(plugin.stateStores ?? {})) {
      stores.set(name, store);
    }
  }
  return stores;
});

/** Load one lazy field, failing with a {@link PluginError} naming the plugin. */
export const resolve = <A>(plugin: Plugin, field: string, thunk: Lazy<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new PluginError({ message: `Could not load ${field} of plugin ${plugin.name}`, cause }),
  });
