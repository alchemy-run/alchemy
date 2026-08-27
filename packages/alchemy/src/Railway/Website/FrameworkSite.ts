import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as NodeNet from "node:net";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { PackageInstall } from "../../Bundle/InstalledPackages.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Output } from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { asEffect } from "../../Util/types.ts";
import { CustomDomain } from "../CustomDomain.ts";
import type { ExtraFile } from "../hosted.ts";
import { Project, type Project as ProjectResource } from "../Project.ts";
import type { Providers } from "../Providers.ts";
import { Service, type Service as ServiceResource } from "../Service.ts";
import { Cdn } from "./Cdn.ts";

/** Port the generated Node serve entry and Railway Service listen on. */
export const WEBSITE_PORT = 3000;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Options for the local dev server that runs a framework site under
 * `alchemy dev`.
 */
export type ServerDevProps =
  | {
      /**
       * Run the framework's own dev server locally (the default).
       * @default "server"
       */
      mode?: "server";
      /**
       * Host the dev server binds to. Defaults to the framework's own
       * choice (localhost).
       */
      host?: string;
      /**
       * Preferred port for the dev server. Defaults to an ephemeral port.
       * If the port is unavailable, the next free port is used unless
       * {@link strictPort} is `true`.
       */
      port?: number;
      /**
       * When `true`, fail instead of falling back to another port if
       * {@link port} is already in use.
       * @default false
       */
      strictPort?: boolean;
    }
  | {
      /**
       * Don't start a dev server; an external dev server is running instead.
       */
      mode: "external";
      /**
       * URL the external dev server is reachable at, if applicable.
       */
      url?: string;
    };

/**
 * How unmatched GET paths are answered. Same names as Cloudflare
 * Workers `assets.notFoundHandling`.
 */
export type WebsiteNotFoundHandling =
  | "none"
  | "single-page-application"
  | "404-page";

/**
 * Static-asset routing. Hashed files are cached by Railway's CDN
 * (enabled on the Service); this bag describes miss/HTML handling on
 * the origin.
 */
export interface WebsiteAssetsProps {
  notFoundHandling?: WebsiteNotFoundHandling;
  htmlHandling?: "none" | "drop-trailing-slash";
}

export const staticConfigFromAssets = (
  assets: WebsiteAssetsProps | undefined,
  defaults?: { notFoundHandling?: WebsiteNotFoundHandling },
): { spa?: boolean; errorPage?: string } => {
  const handling = assets?.notFoundHandling ?? defaults?.notFoundHandling;
  if (handling === "single-page-application") return { spa: true };
  if (handling === "404-page") return { errorPage: "404.html" };
  if (handling === "none") return { spa: false };
  return {};
};

/**
 * Props shared by every Railway framework website composite.
 */
export interface FrameworkSiteProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. When omitted, a `Railway.Project("Project")` is
   * created under this site's namespace.
   */
  project?: Ref<ProjectResource>;
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * Forwarded to the framework integration when it honors memo options.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Process environment for the deployed Service (and, under
   * `alchemy dev`, the framework dev server).
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`). Railway
   * CDN caches hashed files by Content-Type regardless of this bag.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Optional custom hostname attached via `Railway.CustomDomain`. A
   * string is the hostname (`www.example.com`). When set, `url` is
   * `https://{domain}` instead of the generated `*.up.railway.app`.
   */
  domain?: string;
  /**
   * User-defined tags. Railway Services do not persist tags; accepted
   * for API parity with AWS/Cloudflare Website composites.
   */
  tags?: Record<string, string>;
}

/**
 * Static-asset serving options mapped from Cloudflare `AssetsConfig`
 * onto the generated Node serve entry.
 */
export interface WebsiteStaticConfig {
  /**
   * Answer misses with `index.html` (200) so client-side routes
   * deep-link. Mutually exclusive with {@link errorPage}.
   */
  spa?: boolean;
  /**
   * Serve this page (e.g. `404.html`) with status 404 when no file
   * matches. Mutually exclusive with {@link spa}.
   */
  errorPage?: string;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only serving: used when the build produced no server modules
   * (Vite, Foldkit, Vocs, Astro `output: "static"`).
   */
  static?: WebsiteStaticConfig | undefined;
  /**
   * Native packages to `npm install` into the image instead of bundling
   * (Next.js needs `next` / `react`).
   */
  install?: PackageInstall | undefined;
  /**
   * How to bake the build into the image.
   * - `"client"` (default): `COPY dist /app/dist` from `clientDirectory`
   * - `"next"`: `COPY .next` + `public` (and `next.config.*`)
   * @default "client"
   */
  bake?: "client" | "next" | undefined;
}

export interface Website {
  /**
   * Public site URL. Under `alchemy dev` this is the framework (or
   * static) dev server (`http://localhost:<port>`). On deploy it is
   * `https://{domain}` (`*.up.railway.app`, or the custom hostname).
   */
  url: string | Output<string | undefined> | undefined;
  /**
   * The Railway Service that serves the site. `undefined` under
   * `alchemy dev` (no cloud resources are declared).
   */
  service: ServiceResource | undefined;
  /**
   * The Railway Project the Service belongs to. `undefined` under
   * `alchemy dev`.
   */
  project: ProjectResource | undefined;
}

export class FrameworkServerError extends Data.TaggedError(
  "Railway.Website.FrameworkServerError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The structural slice of a framework-integration module
 * (`@alchemy.run/frontend-frameworks/nuxt`, …) this composite drives.
 * Typed structurally so alchemy carries no dependency on
 * `@alchemy.run/frontend-frameworks` — the project's install is loaded.
 */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly build: (options?: {
        readonly root?: string;
        readonly env?: Record<string, string>;
      }) => Effect.Effect<FrameworkBuildOutputSlice, unknown>;
      readonly dev: (options?: {
        readonly root?: string;
        readonly port?: number;
        readonly host?: string;
      }) => Effect.Effect<{ readonly url: string }, unknown>;
    },
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

interface FrameworkBuildOutputSlice {
  readonly distDirectory?: string | undefined;
  readonly clientDirectory: string | undefined;
  readonly serverModules: Array<{ readonly name: string }> | undefined;
}

const importFrameworkModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<Partial<FrameworkModule>>,
    catch: (cause) =>
      new FrameworkServerError({
        framework: specifier,
        message:
          `Failed to import the framework integration "${specifier}". ` +
          "It must be installed in your project (it is loaded dynamically at deploy time).",
        cause,
      }),
  }).pipe(
    Effect.flatMap((module_) =>
      typeof module_.make === "function"
        ? Effect.succeed(module_ as FrameworkModule)
        : Effect.fail(
            new FrameworkServerError({
              framework: specifier,
              message: `"${specifier}" does not export the framework-integration contract (a "make" function)`,
            }),
          ),
    ),
  );

const makeFramework = (config: FrameworkSiteConfig, root: string) =>
  importFrameworkModule(config.framework).pipe(
    Effect.flatMap((module_) =>
      Effect.mapError(
        module_.make({
          ...config.options,
          root,
          target: config.target,
        }),
        (cause) =>
          new FrameworkServerError({
            framework: config.framework,
            message: "Failed to initialize the framework integration",
            cause,
          }),
      ),
    ),
  );

const isPortFree = (port: number, host: string) =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, host, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
  });

const resolveDevPort = Effect.fn(function* (options: {
  readonly framework: string;
  readonly port: number;
  readonly host: string;
  readonly strictPort: boolean;
}) {
  const { framework, port, host, strictPort } = options;
  if (yield* isPortFree(port, host)) return port;
  if (strictPort) {
    return yield* Effect.fail(
      new FrameworkServerError({
        framework,
        message: `Port ${port} is already in use and \`dev.strictPort\` is set`,
      }),
    );
  }
  for (let candidate = port + 1; candidate <= port + 100; candidate++) {
    if (yield* isPortFree(candidate, host)) return candidate;
  }
  return yield* Effect.fail(
    new FrameworkServerError({
      framework,
      message: `No free port found between ${port} and ${port + 100}`,
    }),
  );
});

const envRecord = (
  env: Record<string, string | Redacted.Redacted<string>> | undefined,
): Record<string, string> | undefined => {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );
};

/**
 * Shared implementation behind the Railway framework website composites:
 * build the framework through its Node deploy target, then deploy one
 * `Railway.Service` whose image bakes the Node serve entry plus
 * `clientDirectory`.
 *
 * During `alchemy dev` the site is the framework's own dev server (native
 * HMR) and no cloud resources are declared; `Alchemy.remote()` opts back
 * into the live Service path.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 */
const runFrameworkSite = Effect.fn("Railway.Website.FrameworkSite")(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.resolve(initialCwd, props.rootDir ?? ".");
  const bake = config.bake ?? "client";

  if (isLocal && props.dev?.mode === "external") {
    return {
      url: props.dev.url,
      service: undefined,
      project: undefined,
    } satisfies Website;
  }

  if (isLocal) {
    const framework = yield* makeFramework(config, root);
    const dev = props.dev;
    const port =
      dev && dev.mode !== "external" && dev.port !== undefined
        ? yield* resolveDevPort({
            framework: config.framework,
            port: dev.port,
            host: dev.host ?? "127.0.0.1",
            strictPort: dev.strictPort ?? false,
          })
        : undefined;
    const started = yield* Effect.mapError(
      framework.dev({
        root,
        port,
        host: dev && dev.mode !== "external" ? dev.host : undefined,
      }),
      (cause) =>
        new FrameworkServerError({
          framework: config.framework,
          message: `The ${config.name} dev server failed to start`,
          cause,
        }),
    );
    return {
      url: started.url,
      service: undefined,
      project: undefined,
    } satisfies Website;
  }

  const framework = yield* makeFramework(config, root);
  const built = yield* Effect.mapError(
    framework.build({ root, env: envRecord(props.env) }),
    (cause) =>
      new FrameworkServerError({
        framework: config.framework,
        message: `The ${config.name} build failed`,
        cause,
      }),
  );
  const distDir = path.resolve(
    built.distDirectory ?? built.clientDirectory ?? path.join(root, "dist"),
  );
  const entryName = built.serverModules?.[0]?.name;
  if (entryName === undefined || entryName.length === 0) {
    return yield* Effect.fail(
      new FrameworkServerError({
        framework: config.framework,
        message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
      }),
    );
  }
  const main = path.resolve(distDir, entryName);
  if (!(yield* fs.exists(main))) {
    return yield* Effect.fail(
      new FrameworkServerError({
        framework: config.framework,
        message: `The ${config.name} build produced no server entry at ${main}`,
      }),
    );
  }

  const extraFiles: ExtraFile[] = [];
  if (bake === "next") {
    const nextDir = path.join(root, ".next");
    if (yield* fs.exists(nextDir)) {
      extraFiles.push({ source: nextDir, dest: ".next" });
    }
    const publicDir = path.join(root, "public");
    if (yield* fs.exists(publicDir)) {
      extraFiles.push({ source: publicDir, dest: "public" });
    }
    for (const name of [
      "next.config.js",
      "next.config.mjs",
      "next.config.cjs",
      "next.config.ts",
    ] as const) {
      const configPath = path.join(root, name);
      if (yield* fs.exists(configPath)) {
        extraFiles.push({ source: configPath, dest: name });
      }
    }
  } else {
    extraFiles.push({ source: distDir, dest: "." });
  }

  const project = yield* asEffect(props.project ?? Project("Project"));
  const service = yield* Service("Service", {
    project,
    main,
    port: WEBSITE_PORT,
    healthcheck: "/health",
    isExternal: true,
    env: envRecord(props.env),
    extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
    build:
      config.install !== undefined ? { install: config.install } : undefined,
  });
  yield* Cdn("Cdn", {
    service,
    environment: project,
    htmlCaching: "AUTO",
    purgeOnDeploy: "HTML",
  });

  if (props.domain !== undefined && props.domain.length > 0) {
    yield* CustomDomain("Domain", {
      service,
      environment: project,
      domain: props.domain,
      targetPort: WEBSITE_PORT,
    });
    return {
      url: `https://${props.domain}`,
      service,
      project,
    } satisfies Website;
  }

  return {
    url: service.url,
    service,
    project,
  } satisfies Website;
});

/**
 * Composite-level tagged errors (`FrameworkServerError`, filesystem)
 * are defects — `Alchemy.Stack` only admits `ConfigError` on the user
 * effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);
