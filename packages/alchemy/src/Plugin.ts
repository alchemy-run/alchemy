import { pathToFileURL } from "node:url";
import type * as Command from "effect/cli/Command";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { AlchemyContext } from "./AlchemyContext.ts";
import type { ArtifactStore } from "./Artifacts.ts";
import type { AuthProviders } from "./Auth/AuthProvider.ts";
import type { CredentialsStore } from "./Auth/Credentials.ts";
import type { ProfileStore } from "./Auth/Profile.ts";
import type { CliKit } from "./Cli/CliKit/CliKit.ts";
import type { Interaction } from "./Interaction.ts";
import type { State } from "./State/State.ts";
import { UserFacingError } from "./UserFacingError.ts";
import type { PlatformServices } from "./Util/PlatformServices.ts";

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
  readonly auth?: Lazy<Layer.Layer<never, never, PluginServices>>;
  /**
   * The provider's state store, reachable from a profile alone as
   * `alchemy state --backend <plugin name>`.
   */
  readonly stateStore?: StateStore;
  /** CLI commands the provider adds. */
  readonly cli?: Cli;
  /**
   * Services the test harness runs tests under when `ALCHEMY_TEST_DEV` is
   * set, e.g. a local emulator for the provider's SDK clients.
   */
  readonly testServices?: Lazy<TestServices>;
}

/**
 * The services every host of plugin code provides: the CLI and the Alchemist
 * API both run it under them. A plugin supplies anything else it needs
 * itself, so a field can never require a service no host provides.
 */
export type HostServices =
  | PlatformServices
  | HttpClient
  | AlchemyContext
  | ProfileStore
  | CredentialsStore
  | ArtifactStore
  | Interaction;

/** What auth layers and state stores run under: the host's services and the auth registry. */
export type PluginServices = HostServices | AuthProviders;

/** What a CLI command runs under: the host's services and the terminal. */
export type CliServices = HostServices | CliKit;

/** A plugin's own failure: any tagged error with a message for the user. */
export type PluginFailure = { readonly _tag: string; readonly message: string };
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
  /** Shown when listing stores; no provider code loads to show it. */
  readonly description: string;
  /** The store itself, loaded when it's used. */
  readonly load: Lazy<StateStoreImpl>;
}

export interface StateStoreImpl {
  /** The store's `State` layer: the provider's own `state` function. */
  readonly layer: (options: StateStoreOptions) => Layer.Layer<State, PluginFailure, PluginServices>;
  /** Provisioning, teardown and logs, for the operations the store supports. */
  readonly lifecycle?: StateStoreLifecycle;
}

/** The options every state store's `state(...)` takes. */
export interface StateStoreOptions {
  /** A store other than the account's default, by logical name. */
  readonly name?: string;
}

/** Which store a lifecycle operation acts on, under the profile core resolved. */
export interface StateStoreTarget {
  /** A store other than the account's default, by logical name. */
  readonly name?: string;
}

export interface StateStoreLifecycle {
  /** Provision the store, or adopt it when it exists. Idempotent. */
  readonly bootstrap?: (
    input: StateStoreTarget & {
      /** Redeploy an existing store instead of adopting it. */
      readonly force?: boolean;
    },
  ) => Effect.Effect<StateStoreBootstrap, PluginFailure, PluginServices>;
  /** Delete the store and its backing resources. Idempotent. */
  readonly teardown?: (
    input: StateStoreTarget,
  ) => Effect.Effect<StateStoreTeardown, PluginFailure, PluginServices>;
  /** The store's past log entries, oldest first. */
  readonly logs?: (
    input: StateStoreTarget & { readonly limit?: number; readonly since?: Date },
  ) => Effect.Effect<ReadonlyArray<StateStoreLogEntry>, PluginFailure, PluginServices>;
  /** The store's log entries as they happen. */
  readonly tailLogs?: (
    input: StateStoreTarget,
  ) => Stream.Stream<StateStoreLogEntry, PluginFailure, PluginServices>;
}

export interface StateStoreBootstrap {
  readonly status: "created" | "adopted" | "redeployed";
  /** The store's physical name: its Worker, its bucket. */
  readonly store: string;
  /** Where it lives, e.g. `{ account: "…", region: "us-east-1" }`. */
  readonly location: Readonly<Record<string, string>>;
}

export interface StateStoreTeardown {
  /** What was deleted, by physical name. */
  readonly deleted: ReadonlyArray<string>;
}

export interface StateStoreLogEntry {
  readonly timestamp: Date;
  readonly message: string;
}

export interface Cli {
  /**
   * The `alchemy provider <plugin name>` subcommand. Its description lists it
   * in help; the command itself loads only when it runs.
   */
  readonly provider?: {
    readonly description: string;
    readonly load: Lazy<AnyCommand>;
  };
}

// Any command, whatever its name, errors and the CLI services it runs under.
export type AnyCommand = Command.Command<any, any, any, PluginFailure, CliServices>;

export interface TestServices {
  /** Provided to test bodies and stack programs, closest wins. */
  readonly layer: Layer.Layer<any, PluginFailure, never>;
  /** Rewrites the test's outbound HTTP, e.g. onto the emulator's gateway. */
  readonly mapRequest?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
  /** Set on the test process before anything forks, unless already set. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Declare a plugin; the identity function, keeping its literal type. */
export const make = <const P extends Plugin>(plugin: P): P => plugin;

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
  const own = yield* readManifest(
    yield* path.fromFileUrl(new URL("../package.json", import.meta.url)),
  );
  // The project's dependencies that declare plugins, before alchemy's own:
  // the first plugin with a name wins, so a provider that moved into its own
  // package replaces the copy still inside alchemy.
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
  // alchemy's own: the providers that still live in this package.
  for (const specifier of own?.alchemy?.plugins ?? []) declared.set(specifier, { specifier });
  // A plugin that fails to load is skipped, never the rest; the first plugin
  // with a name wins, and `--backend` names alchemy reserves are taken.
  const plugins = new Map<string, Plugin>();
  for (const declaration of declared.values()) {
    const plugin = yield* importPlugin(declaration).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(`Skipping plugin ${declaration.specifier}: ${error.message}`),
          undefined,
        ),
      ),
    );
    if (plugin === undefined) continue;
    if (
      plugins.has(plugin.name) ||
      (RESERVED_BACKENDS as ReadonlyArray<string>).includes(plugin.name)
    ) {
      // Expected for alchemy's own copy of a provider that moved out.
      yield* (declaration.manifest ? Effect.logWarning : Effect.logDebug)(
        `Skipping plugin ${declaration.specifier}: the name ${plugin.name} is taken`,
      );
      continue;
    }
    plugins.set(plugin.name, plugin);
  }
  return [...plugins.values()];
});

/** `--backend` names alchemy handles itself, so no plugin may take them. */
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

/** Every plugin's state store, by `--backend` (plugin) name, with its plugin. */
export const stateStores = Effect.fn("Plugin.stateStores")(function* () {
  const stores = new Map<string, { readonly plugin: Plugin; readonly store: StateStore }>();
  for (const plugin of yield* load()) {
    if (plugin.stateStore) stores.set(plugin.name, { plugin, store: plugin.stateStore });
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
