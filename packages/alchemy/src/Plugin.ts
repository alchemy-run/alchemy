import { pathToFileURL } from "node:url";
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

/**
 * A field loaded when used, so importing a plugin module stays cheap. Build
 * one with {@link lazy}.
 */
export type Lazy<A> = Effect.Effect<A, PluginError>;

/**
 * A {@link Lazy} field from a module of the provider's, imported on first
 * use:
 *
 * ```ts
 * auth: Plugin.lazy(() => import("./AuthProvider.ts"), (module) => module.AwsAuth),
 * ```
 */
export const lazy = <M, A>(load: () => Promise<M>, pick: (module: M) => A): Lazy<A> =>
  Effect.tryPromise({
    try: load,
    catch: (cause) => new PluginError({ message: "Could not import a plugin module", cause }),
  }).pipe(Effect.map(pick));

export interface StateStore {
  readonly description: string;
  /**
   * The store's `State` layer, for the named store or the default one.
   * Built under the requested profile's config with an `AuthProviders`
   * registry in context.
   */
  readonly layer: Lazy<(options: { readonly name?: string }) => Layer.Layer<State, any, any>>;
  /**
   * Provisioning for a store that is infrastructure of its own, such as
   * Cloudflare's state-store Worker. Omit it for a store that needs none,
   * like AWS's S3 store, which creates its bucket on first use.
   */
  readonly lifecycle?: Lazy<StateStoreLifecycle>;
}

/** Which store, profile and `.env` a state-store operation acts under. */
export interface StateStoreTarget {
  /**
   * A store other than the account's default: an S3 bucket, a state-store
   * Worker. Every state store must support more than one per account.
   */
  readonly name?: string;
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
  /**
   * A subcommand of `alchemy provider`. Its name and description list it in
   * help; the command itself loads only when it runs.
   */
  readonly provider?: {
    readonly name: string;
    readonly description: string;
    readonly load: Lazy<AnyCommand>;
  };
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
  main: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
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

/** A plugin specifier, and the manifest that declared it when not alchemy's own. */
interface Declared {
  readonly specifier: string;
  readonly manifest?: {
    readonly file: string;
    readonly directory: string;
    readonly name: string | undefined;
    readonly main: string | undefined;
    readonly exports: unknown;
  };
}

/** The conditions an ESM `import` resolves exports with, in priority order. */
const importConditions = new Set(
  typeof Bun !== "undefined" ? ["bun", "import", "node", "default"] : ["import", "node", "default"],
);

/** An `exports` target under {@link importConditions}, with `*` filled in. */
const exportTarget = (target: unknown, star: string): string | undefined => {
  if (typeof target === "string") return target.replaceAll("*", star);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = exportTarget(candidate, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === "object" && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!importConditions.has(condition)) continue;
      const resolved = exportTarget(value, star);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** A package's own subpath (`"."`, `"./Plugin"`) through its `exports` map. */
const packageExport = (exports: unknown, main: string | undefined, subpath: string) => {
  if (exports === undefined) return subpath === "." ? (main ?? "./index.js") : subpath;
  const map =
    typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)
      : { ".": exports };
  if (subpath in map) return exportTarget(map[subpath], "");
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return exportTarget(target, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
};

/**
 * Resolve a dependency's plugin from the dependency itself, through its own
 * `exports` with ESM import conditions: under pnpm alchemy usually can't see
 * a project's dependencies, and a CommonJS resolver would pick `require`
 * targets for a module loaded with `import()`. A plugin specifier must name
 * the package that declares it.
 */
const resolveDeclared = ({ specifier, manifest }: Declared) =>
  Effect.gen(function* () {
    if (manifest === undefined) return specifier;
    const path = yield* Path.Path;
    const { name } = manifest;
    if (name === undefined || (specifier !== name && !specifier.startsWith(`${name}/`))) {
      return yield* new PluginError({
        message: `Plugin ${specifier} declared in ${manifest.file} must name that package (${name ?? "unnamed"})`,
      });
    }
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = packageExport(manifest.exports, manifest.main, subpath);
    if (target === undefined) {
      return yield* new PluginError({
        message: `Plugin ${specifier} is not exported for import by ${manifest.file}`,
      });
    }
    return pathToFileURL(path.join(manifest.directory, target)).href;
  });

const importPlugin = (declared: Declared) =>
  Effect.flatMap(resolveDeclared(declared), (url) =>
    Effect.tryPromise({
      try: () => import(url) as Promise<{ readonly default?: unknown }>,
      catch: (cause) =>
        new PluginError({ message: `Could not import plugin ${declared.specifier}`, cause }),
    }),
  ).pipe(
    Effect.flatMap((module) =>
      typeof module.default === "object" &&
      module.default !== null &&
      typeof (module.default as Plugin).name === "string"
        ? Effect.succeed(module.default as Plugin)
        : Effect.fail(
            new PluginError({
              message: `Plugin ${declared.specifier} has no default-exported plugin`,
            }),
          ),
    ),
  );

const discover = Effect.fn("Plugin.discover")(function* (cwd: string) {
  const path = yield* Path.Path;
  const declared = new Map<string, Declared>();
  // alchemy's own: the providers that still live in this package.
  const own = yield* readManifest(
    yield* path.fromFileUrl(new URL("../package.json", import.meta.url)),
  );
  for (const specifier of own?.alchemy?.plugins ?? []) declared.set(specifier, { specifier });
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
    for (const specifier of manifest?.alchemy?.plugins ?? []) {
      declared.set(specifier, {
        specifier,
        manifest: {
          file,
          directory: path.dirname(file),
          name: manifest?.name,
          main: manifest?.main,
          exports: manifest?.exports,
        },
      });
    }
  }
  const plugins = yield* Effect.forEach(declared.values(), importPlugin, {
    concurrency: "unbounded",
  });
  const seen = new Set<string>();
  // `--backend` names: alchemy's own, then each plugin's state stores.
  const backends = new Map<string, string>(RESERVED_BACKENDS.map((name) => [name, "alchemy"]));
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      return yield* new PluginError({ message: `Two plugins are named ${plugin.name}` });
    }
    seen.add(plugin.name);
    for (const backend of Object.keys(plugin.stateStores ?? {})) {
      const owner = backends.get(backend);
      if (owner !== undefined) {
        return yield* new PluginError({
          message: `Plugin ${plugin.name} registers state store '${backend}', which ${owner === "alchemy" ? "alchemy reserves" : `plugin ${owner} already registers`}`,
        });
      }
      backends.set(backend, plugin.name);
    }
  }
  return plugins;
});

/** `--backend` names alchemy handles itself, never a plugin's state store. */
export const RESERVED_BACKENDS = ["local", "configured"] as const;

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
export const resolve = <A>(plugin: Plugin, field: string, value: Lazy<A>) =>
  value.pipe(
    Effect.mapError(
      (cause) =>
        new PluginError({
          message: `Could not load ${field} of plugin ${plugin.name}: ${cause.message}`,
          cause,
        }),
    ),
  );
