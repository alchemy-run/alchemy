import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "alchemy/Website/assets";
import { packSiteExtraFiles } from "alchemy/Website/packExtraFiles";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { App, type AppInstanceSize, type AppProps } from "../App.ts";

/** Port the site's server listens on inside the App container. */
export const DEFAULT_WEBSITE_PORT = 8080;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/**
 * Props shared by every DigitalOcean framework website composite.
 */
export interface FrameworkSiteProps {
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /** Options for the local dev server that runs this site under `alchemy dev`. */
  dev?: ServerDevProps;
  /**
   * Environment of the server (and the local framework dev server).
   * Accepts `Output`s (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>;
  /** Static-asset routing (`notFoundHandling`, `htmlHandling`). */
  assets?: WebsiteAssetsProps;
  /** App Platform region. @default "nyc" */
  region?: AppProps["region"];
  /** Instance size. @default "apps-s-1vcpu-0.5gb" */
  instanceSizeSlug?: AppInstanceSize;
  /** Instances behind the App's load balancer. @default 1 */
  instanceCount?: number;
  /** Container Registry the image is pushed to. @default the team's registry */
  registry?: AppProps["registry"];
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node deploy-target module specifier. */
  target: string;
  /** Framework-specific build options forwarded to the integration. */
  options?: Record<string, unknown> | undefined;
  /** Assets-only mode: the composite serves the static output. */
  static?:
    | {
        spa?: boolean | undefined;
        errorPage?: string | undefined;
        htmlHandling?: "none" | "drop-trailing-slash" | undefined;
      }
    | undefined;
  /** Serve `about/index.html` at `/about`. @default "none" */
  htmlHandling?: "none" | "drop-trailing-slash";
  /** Skip copying `clientDirectory` (Next.js serves `.next` itself). */
  skipClientAssets?: boolean | undefined;
  /** Native packages installed into the image instead of bundled. */
  install?: string[] | undefined;
}

export interface Website {
  /** Local framework URL under `alchemy dev`, or the App's live URL. */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /** The App serving the site. `undefined` during `alchemy dev`. */
  readonly app: App | undefined;
}

export class FrameworkSiteError extends Data.TaggedError(
  "DigitalOcean.Website.FrameworkSiteError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
  env:
    | Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>
    | undefined,
): Record<string, string | Output.Output<string | undefined>> | undefined =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

/** The App props every website shares. */
export const appProps = (
  props: Pick<FrameworkSiteProps, "region" | "instanceSizeSlug" | "instanceCount" | "registry">,
  port: number,
) => ({
  region: props.region,
  instanceSizeSlug: props.instanceSizeSlug,
  instanceCount: props.instanceCount,
  registry: props.registry,
  port,
  isExternal: true as const,
  standalone: true,
});

/**
 * Shared implementation behind the DigitalOcean framework website
 * composites: build through the Node deploy target, then run the server as
 * an App Platform service. The image is the build's server tree as built
 * (never re-bundled, so relative imports between its chunks hold) plus the
 * client assets, on a Node base.
 *
 * Every site, static ones included, runs as an App service: Spaces serves
 * objects but has no index documents or single-page fallback, and App
 * Platform's own static sites build only from a git repository.
 *
 * During `alchemy dev` the site is the framework's own dev server and no
 * cloud resources are declared; `Alchemy.remote()` opts back into the App.
 */
const runFrameworkSite = Effect.fn("DigitalOcean.Website.FrameworkSite")(function* (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const port = DEFAULT_WEBSITE_PORT;

  if (config.static?.spa && config.static.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }

  const build = yield* FrameworkServer("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: unwrapEnv(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) return { url: build.url, app: undefined } satisfies Website;

  // The build runs at apply time, so its attributes are Outputs here; the
  // resource's attribute types don't carry that, hence the casts.
  const buildOut = Output.mapEffect(
    ([serverEntry, distDir]: [string | undefined, string | undefined]) =>
      Effect.gen(function* () {
        if (serverEntry === undefined || distDir === undefined) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no Node serve entry (serverModules[0]).`,
            }),
          );
        }
        const main = path.resolve(initialCwd, serverEntry);
        if (!(yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no server entry at ${main}`,
            }),
          );
        }
        return { distDir: path.resolve(initialCwd, distDir), main };
      }),
  )(
    Output.all(
      build.serverEntry as unknown as Output.Output<string | undefined>,
      build.distDir as unknown as Output.Output<string | undefined>,
    ) as unknown as Output.Output<[string | undefined, string | undefined]>,
  );
  const main = Output.map(buildOut, (out) => out.main);
  const extraFiles = Output.mapEffect((out: { distDir: string; main: string }) =>
    packSiteExtraFiles(out.distDir, config.skipClientAssets === true ? "next" : "client").pipe(
      Effect.map((files) => files?.map((file) => ({ source: file.source, dest: file.dest })) ?? []),
    ),
  )(buildOut);

  // `main` and `extraFiles` are Outputs of the build, resolved by the engine
  // before the App reconciles; the props type has no Output-of-array form.
  // Pin each installed package to the version the site itself resolved, so
  // the image installs exactly what the build ran against.
  const rootDir = path.resolve(initialCwd, props.rootDir ?? ".");
  const packages = yield* Effect.forEach(config.install ?? [], (name) =>
    fs.readFileString(path.join(rootDir, "node_modules", name, "package.json")).pipe(
      Effect.map((text) => [name, (JSON.parse(text) as { version: string }).version] as const),
      Effect.orElseSucceed(() => [name, "*"] as const),
    ),
  );

  const app = yield* App(id, {
    ...appProps(props, port),
    main: main as unknown as string,
    extraFiles: extraFiles as unknown as Array<{ source: string; dest: string }>,
    packages: packages.length > 0 ? Object.fromEntries(packages) : undefined,
    env: { ...unwrapEnv(props.env), PORT: String(port) },
  });
  return { url: app.url, app } satisfies Website;
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects: `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);
