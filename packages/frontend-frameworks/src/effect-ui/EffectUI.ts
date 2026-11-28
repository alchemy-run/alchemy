import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { Plugin } from "vite";
import * as Core from "../core/index.ts";
import type { NodeServeHtmlHandling, NodeServeNotFoundHandling } from "../core/NodeServe.ts";
import { make as makeVite, type ViteBuildConfig } from "../vite/Vite.ts";

/** The name of the plugin `@effect/ui/html/HtmlServerVite` returns. */
export const HTML_SERVER_PLUGIN_NAME = "effect-ui-html-server";

/** The marker `HtmlServer.document` replaces with a rendered page. */
export const APP_HTML_MARKER = "<!--app-html-->";

export interface EffectUITargetConfig {
  /** Serializable overrides for the project's Vite configuration. */
  readonly vite?: ViteBuildConfig | undefined;
  /** AWS topology: browser-only, prerendered assets, or a server with assets. Omit for automatic detection. */
  readonly output?: "spa" | "static" | "server" | undefined;
  /** Override the default SPA fallback for browser-only builds. */
  readonly notFoundHandling?: NodeServeNotFoundHandling | undefined;
  /** Override static HTML routing. */
  readonly htmlHandling?: NodeServeHtmlHandling | undefined;
}
export interface EffectUITarget extends Core.DeployTarget<EffectUITargetConfig> {
  /**
   * Vite plugins the target adds to the app's build and dev server (e.g.
   * Cloudflare's runtime plugin). A target with plugins builds every
   * environment with them and deploys the server bundle they produce.
   */
  readonly vitePlugins?: ((context: { readonly root: string }) => Array<Plugin>) | undefined;
}
export type EffectUITargetInput = Core.DeployTargetInput<EffectUITarget, EffectUITargetConfig>;
export interface EffectUIOptions extends EffectUITargetConfig {
  /** Project directory. @default process.cwd() */
  readonly root?: string | undefined;
  /** Deployment target. @default "@alchemy.run/frontend-frameworks/effect-ui/aws" */
  readonly target?: EffectUITargetInput | undefined;
  /** Native Vite development server options. */
  readonly dev?: { readonly port?: number | undefined } | undefined;
}
export const DEFAULT_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/effect-ui/aws";

/** The server handler `HtmlServerVite` writes to its `serverOutDir`. */
export interface EffectUIServerBuild {
  readonly directory: string;
  readonly entry: string;
}

interface ViteBuilder {
  readonly config: {
    readonly root: string;
    readonly base: string;
    readonly plugins: ReadonlyArray<Pick<Plugin, "name">>;
    readonly build: { readonly outDir: string };
  };
  readonly environments: Record<
    string,
    {
      readonly config: {
        readonly root: string;
        readonly base: string;
        readonly build: { readonly outDir: string };
      };
    }
  >;
  readonly buildApp: () => Promise<unknown>;
  readonly build: (environment: unknown) => Promise<unknown>;
}
interface ViteModule {
  readonly createBuilder: (
    config: Record<string, unknown>,
    useLegacyBuilder?: null,
  ) => Promise<ViteBuilder>;
}
const fail = (message: string, cause?: unknown) =>
  new Core.FrameworkError({ framework: "effect-ui", message, cause });

const hasPlugin = (plugins: ViteBuilder["config"]["plugins"], name: string) =>
  plugins.some((plugin) => plugin.name === name);

/**
 * Without a prerendered home page, a server build's client `index.html` is
 * still the template the server fills (the server bundle inlines its own
 * copy). Served as a file, it would answer `/` with an empty page.
 */
const removeUnrenderedShell = Effect.fnUntraced(function* (clientDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = path.join(clientDirectory, "index.html");
  if ((yield* fs.exists(shell)) && (yield* fs.readFileString(shell)).includes(APP_HTML_MARKER)) {
    yield* fs.remove(shell);
  }
});

/**
 * Package only deployment artifacts. `server` is the handler
 * `HtmlServerVite` emits when the app sets `serverOutDir`; `prerendered`
 * says whether the plugin ran at all.
 */
export const readEffectUIOutput = (
  root: string,
  clientDirectory: string,
  server: EffectUIServerBuild | undefined,
  options: {
    readonly output?: EffectUITargetConfig["output"];
    readonly prerendered: boolean;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { output } = options;
    if (output === "spa" && server) {
      return yield* fail(
        'Effect UI produced a server handler. Set output: "server" to deploy it, or remove serverOutDir from HtmlServerVite.plugin to deploy only prerendered pages.',
      );
    }
    if (output === "server" && !server) {
      return yield* fail(
        'Effect UI produced no server handler. Set serverOutDir in HtmlServerVite.plugin, or omit output: "server".',
      );
    }
    if (output === "static" && !options.prerendered) {
      return yield* fail(
        'Static Effect UI output requires prerendered pages. Add HtmlServerVite.plugin to vite.config.ts with a prerender list, or omit output: "static".',
      );
    }
    // Packaging lives outside `.alchemy`, which Neon's packager refuses to
    // ship from, and like it is gitignored and excluded from build memos.
    const distDirectory = path.join(root, "node_modules", ".cache", "alchemy", "effect-ui");
    const isWithin = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    for (const directory of [clientDirectory, ...(server ? [server.directory] : [])]) {
      if (isWithin(distDirectory, directory) || isWithin(directory, distDirectory)) {
        return yield* fail(
          "Effect UI output directories must not overlap node_modules/.cache/alchemy/effect-ui, which is reserved for deployment packaging.",
        );
      }
    }
    yield* fs.remove(distDirectory, { recursive: true, force: true });
    yield* fs.makeDirectory(distDirectory, { recursive: true });
    const client = path.join(distDirectory, "client");
    yield* fs.copy(clientDirectory, client);
    if (!server || output === "static") {
      return {
        output: {
          distDirectory,
          clientDirectory: client,
          serverModules: undefined,
          externalWorkspaces: new Set<string>(),
        } satisfies Core.BuildOutput,
        entry: undefined,
      };
    }
    yield* removeUnrenderedShell(client);
    const serverDirectory = path.join(distDirectory, "server");
    yield* fs.copy(server.directory, serverDirectory);
    const entryName = path.relative(server.directory, server.entry).replaceAll("\\", "/");
    const modules = yield* Core.readServerModulesFromDisk({
      directory: serverDirectory,
      prefix: "server",
    });
    if (!modules.some((module) => module.name === `server/${entryName}`)) {
      return yield* fail("Effect UI's server entry is missing from the build output.");
    }
    return {
      output: {
        distDirectory,
        clientDirectory: client,
        serverModules: Core.sortServerModules(modules, `server/${entryName}`),
        externalWorkspaces: new Set<string>(),
      } satisfies Core.BuildOutput,
      entry: path.join(serverDirectory, entryName),
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Core.FrameworkError
        ? cause
        : fail("Failed to collect Effect UI build output", cause),
    ),
  );

/** Build with the project's plugin and host its native development server. */
export const make: (
  options?: EffectUIOptions,
) => Effect.Effect<Core.Framework["Service"], never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options: EffectUIOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseRoot = options.root ?? process.cwd();
    const config: EffectUITargetConfig = {
      vite: options.vite,
      output: options.output,
      notFoundHandling: options.notFoundHandling,
      htmlHandling: options.htmlHandling,
    };
    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const resolveTarget = (root: string, input: EffectUITargetInput) =>
      Core.resolveDeployTarget<EffectUITarget, EffectUITargetConfig>(root, input, config).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
      );
    const inlineConfig = (root: string) => ({
      root,
      logLevel: "warn",
      ...(options.vite?.configFile !== undefined
        ? { configFile: path.resolve(root, options.vite.configFile) }
        : {}),
      ...(options.vite?.base !== undefined ? { base: options.vite.base } : {}),
      ...(options.vite?.outDir !== undefined ? { build: { outDir: options.vite.outDir } } : {}),
    });
    /**
     * Build every environment with the target's plugins, which bundle the
     * server handler `HtmlServerVite` generates for the target's runtime.
     */
    const buildWithTargetPlugins = Effect.fn(function* (
      vite: ViteModule,
      target: EffectUITarget & {
        readonly vitePlugins: NonNullable<EffectUITarget["vitePlugins"]>;
      },
      context: Core.DeployTargetFinishContext,
    ) {
      const collector = yield* provide(Core.makeBuildOutputCollector({ entryEnvironment: "ssr" }));
      const { assetBase, rendersPages } = yield* Effect.tryPromise({
        try: async () => {
          const builder = await vite.createBuilder(
            {
              ...inlineConfig(context.root),
              plugins: [...target.vitePlugins({ root: context.root }), collector.plugin],
            },
            null,
          );
          await builder.buildApp();
          return {
            // The `base` the client's URLs were rewritten with, which the
            // uploaded asset paths must agree with.
            assetBase: (builder.environments.client?.config ?? builder.config).base,
            // Whether the server is `HtmlServerVite`'s, not a custom `main`.
            rendersPages: hasPlugin(builder.config.plugins, HTML_SERVER_PLUGIN_NAME),
          };
        },
        catch: (cause) =>
          cause instanceof Core.FrameworkError ? cause : fail("Failed to build Effect UI", cause),
      });
      const collected = yield* collector
        .collect()
        .pipe(Effect.mapError((error) => fail(error.message, error.cause)));
      if (
        rendersPages &&
        collected.serverModules?.length &&
        collected.clientDirectory !== undefined
      ) {
        yield* provide(removeUnrenderedShell(collected.clientDirectory)).pipe(
          Effect.mapError((cause) => fail("Failed to collect Effect UI build output", cause)),
        );
      }
      const output = { ...collected, assetBase };
      return yield* provide(Core.applyDeployTargetFinish(target, output, context)).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
      );
    });
    const build: Core.Framework["Service"]["build"] = Effect.fn(function* (buildOptions) {
      const root = path.resolve(buildOptions?.root ?? baseRoot);
      const target = yield* resolveTarget(root, options.target ?? DEFAULT_TARGET_SPECIFIER);
      const context = { root, framework: "effect-ui", env: buildOptions?.env };
      if (target.build)
        return yield* provide(target.build(context)).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
        );
      const vite = yield* Core.loadProjectModule<ViteModule>(root, "vite").pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
      );
      const { vitePlugins } = target;
      if (vitePlugins !== undefined) {
        return yield* buildWithTargetPlugins(vite, { ...target, vitePlugins }, context);
      }
      const built = yield* Effect.tryPromise({
        try: async () => {
          let server: EffectUIServerBuild | undefined;
          const outputPlugin: Plugin = {
            name: "alchemy:effect-ui-output",
            enforce: "post",
            // Like TanStack Start, deploy a self-contained server bundle.
            // Only a build with `serverOutDir` writes it.
            config: () => ({
              ssr: { noExternal: true },
              environments: { ssr: { resolve: { noExternal: true } } },
            }),
            writeBundle(outputOptions, bundle) {
              if (this.environment.name !== "ssr" || outputOptions.dir === undefined) return;
              const entry = Object.values(bundle).find(
                (file) => file.type === "chunk" && file.isEntry,
              );
              if (entry === undefined) return;
              server = {
                directory: outputOptions.dir,
                entry: path.join(outputOptions.dir, entry.fileName),
              };
            },
          };
          const builder = await vite.createBuilder({
            ...inlineConfig(root),
            plugins: [outputPlugin],
          });
          const prerendered = hasPlugin(builder.config.plugins, HTML_SERVER_PLUGIN_NAME);
          // Without `HtmlServerVite` the app is client-only; the default
          // `buildApp` would also build the `ssr` environment, whose only
          // input is `index.html`.
          if (prerendered) await builder.buildApp();
          else await builder.build(builder.environments.client);
          const client = builder.environments.client?.config ?? builder.config;
          return {
            server,
            prerendered,
            assetBasePath: decodeURIComponent(new URL(client.base, "http://localhost").pathname),
            client: path.resolve(client.root, client.build.outDir),
          };
        },
        catch: (cause) => fail("Failed to build Effect UI", cause),
      });
      const collected = yield* provide(
        readEffectUIOutput(root, built.client, built.server, {
          output: options.output,
          prerendered: built.prerendered,
        }),
      );
      return yield* provide(
        Core.applyDeployTargetFinish(target, collected.output, {
          ...context,
          entry: collected.entry,
          assetBasePath: built.assetBasePath,
        }),
      ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
    });
    // The project's native dev server (`HtmlServerVite` renders pages in
    // it), with the target's plugins when an explicit target brings any.
    const dev: Core.Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
      const root = path.resolve(devOptions?.root ?? baseRoot);
      const target =
        options.target === undefined ? undefined : yield* resolveTarget(root, options.target);
      const native = yield* provide(
        makeVite({
          root: baseRoot,
          vite: options.vite,
          dev: { ...options.dev, plugins: target?.vitePlugins?.({ root }) },
        }),
      );
      return yield* native.dev(devOptions);
    });
    return Core.Framework.of({ build, dev });
  });

export const layer = (
  options?: EffectUIOptions,
): Layer.Layer<Core.Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Core.Framework, make(options));
