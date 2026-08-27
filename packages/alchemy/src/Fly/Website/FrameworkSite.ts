import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as NodeNet from "node:net";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import type { Output } from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { App } from "../App.ts";
import { Bucket } from "../Bucket.ts";
import { Certificate } from "../Certificate.ts";
import { IpAssignment } from "../IpAssignment.ts";
import type { Providers } from "../Providers.ts";
import { Service } from "../Service.ts";
import { AssetDeployment } from "./AssetDeployment.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
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
 * Static-asset routing. The Fly half of the shared Website vocabulary
 * (`rootDir` / `env` / `memo` / `assets` / `dev`). Hashed files are
 * published to a public Tigris bucket and served via Machine `statics`;
 * this bag only describes miss/HTML handling on the origin.
 */
export interface WebsiteAssetsProps {
  /**
   * `"single-page-application"` serves `index.html` (200).
   * `"404-page"` serves `404.html` with status 404.
   * `"none"` falls through to the framework handler (or a 404).
   */
  notFoundHandling?: WebsiteNotFoundHandling;
  /**
   * Serve `about/index.html` at `/about` (Cloudflare
   * `htmlHandling: "drop-trailing-slash"`).
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
}

/** Map {@link WebsiteAssetsProps} onto the generated Node serve entry. */
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
 * Props shared by every Fly framework website composite.
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
  /**
   * Parent Fly App. Accepts a `Fly.App` or an Effect that produces one.
   * When omitted, a `Fly.App` is created under this site's namespace.
   */
  app?: Ref<App>;
  /**
   * Process environment for the hosted server. Not Cloudflare Worker
   * bindings — values become Machine env vars.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`). Hashed
   * client files are uploaded to Tigris regardless of this bag.
   */
  assets?: WebsiteAssetsProps;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Optional custom hostname. Requests ACME (`Fly.Certificate`) on the
   * App. `url` becomes `https://<domain>` (existing DNS only for v1).
   */
  domain?: string;
  /**
   * User-defined tags. Accepted for API parity; Fly Services do not
   * surface resource tags.
   */
  tags?: Record<string, string>;
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
   * Assets-only routing forwarded to the Node target (Vite SPA fallback).
   * `spa` also publishes client files to Tigris at `/`.
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Packages installed into the Machine image with `npm install` instead
   * of bundling (Next.js needs `next`).
   */
  install?: string[] | undefined;
  /**
   * Skip baking `clientDirectory` at `/app/dist`. Next.js serves `.next`
   * from the image root instead.
   */
  skipClientAssets?: boolean | undefined;
}

export interface FrameworkSite {
  /**
   * Public site URL. Local framework URL under `alchemy dev`;
   * `https://{app}.fly.dev` (or `https://{domain}`) on deploy.
   */
  url: string | Output<string | undefined> | undefined;
  /** Parent Fly App. `undefined` during `alchemy dev`. */
  app: App | undefined;
  /** Hosted Fly Service. `undefined` during `alchemy dev`. */
  service: Service | undefined;
  /** Shared Anycast IPv4 so `{app}.fly.dev` answers. */
  ip: IpAssignment | undefined;
  /** ACME certificate when {@link FrameworkSiteProps.domain} is set. */
  certificate: Certificate | undefined;
}

/**
 * The structural slice of a framework-integration module this composite
 * drives. Typed structurally so alchemy carries no dependency on
 * `@alchemy.run/frontend-frameworks` — the *project's* install is always
 * the one loaded.
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

export class FrameworkSiteError extends Data.TaggedError("FrameworkSiteError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DEFAULT_PORT = 3000;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

const importFrameworkModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<Partial<FrameworkModule>>,
    catch: (cause) =>
      new FrameworkSiteError({
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
            new FrameworkSiteError({
              framework: specifier,
              message: `"${specifier}" does not export the framework-integration contract (a "make" function)`,
            }),
          ),
    ),
  );

const makeFramework = (
  config: FrameworkSiteConfig,
  root: string,
  memo?: MemoOptions | boolean,
) =>
  importFrameworkModule(config.framework).pipe(
    Effect.flatMap((module_) =>
      Effect.mapError(
        module_.make({
          ...config.options,
          root,
          target: config.target,
          ...(memo !== undefined ? { memo } : {}),
        }),
        (cause) =>
          new FrameworkSiteError({
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
      new FrameworkSiteError({
        framework,
        message: `Port ${port} is already in use and \`dev.strictPort\` is set`,
      }),
    );
  }
  for (let candidate = port + 1; candidate <= port + 100; candidate++) {
    if (yield* isPortFree(candidate, host)) return candidate;
  }
  return yield* Effect.fail(
    new FrameworkSiteError({
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

const runFrameworkSite = Effect.fn("Fly.Website.FrameworkSite")(function* (
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

  if (isLocal && props.dev?.mode === "external") {
    return {
      url: props.dev.url,
      app: undefined,
      service: undefined,
      ip: undefined,
      certificate: undefined,
    } satisfies FrameworkSite;
  }

  if (isLocal) {
    const framework = yield* makeFramework(config, root, props.memo);
    const dev = props.dev;
    const resolvedPort =
      dev && dev.mode !== "external" && dev.port !== undefined
        ? yield* resolveDevPort({
            framework: config.framework,
            port: dev.port,
            host: dev.host ?? "127.0.0.1",
            strictPort: dev.strictPort ?? false,
          })
        : undefined;
    const { url } = yield* Effect.mapError(
      framework.dev({
        root,
        port: resolvedPort,
        host: dev && dev.mode !== "external" ? dev.host : undefined,
      }),
      (cause) =>
        new FrameworkSiteError({
          framework: config.framework,
          message: `The ${config.name} dev server failed to start`,
          cause,
        }),
    );
    return {
      url,
      app: undefined,
      service: undefined,
      ip: undefined,
      certificate: undefined,
    } satisfies FrameworkSite;
  }

  const framework = yield* makeFramework(config, root, props.memo);
  const built = yield* Effect.mapError(
    framework.build({ root, env: envRecord(props.env) }),
    (cause) =>
      new FrameworkSiteError({
        framework: config.framework,
        message: `The ${config.name} build failed`,
        cause,
      }),
  );

  const distDir = path.resolve(
    built.distDirectory ?? built.clientDirectory ?? path.join(root, "dist"),
  );
  const clientDir =
    built.clientDirectory !== undefined
      ? path.resolve(built.clientDirectory)
      : undefined;
  const entryName = built.serverModules?.[0]?.name;
  if (entryName === undefined || entryName.length === 0) {
    return yield* Effect.fail(
      new FrameworkSiteError({
        framework: config.framework,
        message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
      }),
    );
  }
  const main = path.resolve(distDir, entryName);
  if (!(yield* fs.exists(main))) {
    return yield* Effect.fail(
      new FrameworkSiteError({
        framework: config.framework,
        message: `The ${config.name} build produced no server entry at ${main}`,
      }),
    );
  }

  const extraFiles: Array<{ source: string; dest: string }> = [];
  if (config.skipClientAssets) {
    const nextDir = path.join(distDir, ".next");
    if (yield* fs.exists(nextDir).pipe(Effect.orElseSucceed(() => false))) {
      extraFiles.push({ source: nextDir, dest: ".next" });
    }
    const publicDir = path.join(distDir, "public");
    if (yield* fs.exists(publicDir).pipe(Effect.orElseSucceed(() => false))) {
      extraFiles.push({ source: publicDir, dest: "public" });
    }
    for (const name of [
      "next.config.js",
      "next.config.mjs",
      "next.config.cjs",
      "next.config.ts",
    ] as const) {
      const configPath = path.join(distDir, name);
      if (
        yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false))
      ) {
        extraFiles.push({ source: configPath, dest: name });
      }
    }
  } else {
    extraFiles.push({ source: distDir, dest: "." });
  }

  const app =
    props.app !== undefined ? yield* resolveRef(props.app) : yield* App("App");

  const ip = yield* IpAssignment("Shared", {
    app,
    type: "shared_v4",
  });

  // SPA: hashed `/assets` at Tigris. HTML and unknown paths stay on
  // origin (NodeServe `notFoundHandling: "spa"`). Intercepting `/` with
  // Tigris hangs SPA fallbacks — Fly does not rewrite `/counter/42` to
  // `index.html`.
  let statics:
    | Array<{
        guestPath: string;
        urlPrefix: string;
        tigrisBucket?: string;
        indexDocument?: string;
      }>
    | undefined;
  if (config.static?.spa === true && clientDir !== undefined) {
    const bucket = yield* Bucket("Assets", { public: true });
    yield* AssetDeployment("Files", {
      bucket,
      sourcePath: clientDir,
      purge: true,
    });
    const assetsDir = path.join(clientDir, "assets");
    if (yield* fs.exists(assetsDir).pipe(Effect.orElseSucceed(() => false))) {
      statics = [
        {
          guestPath: "/assets",
          urlPrefix: "/assets",
          tigrisBucket: bucket.name as unknown as string,
        },
      ];
    }
  }

  const service = yield* Service("Service", {
    app,
    main,
    port: DEFAULT_PORT,
    // Node + nitro SSR needs more than the Machine default 256MB.
    guest: { memoryMb: 512 },
    isExternal: true,
    env: props.env,
    extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
    statics,
    build:
      config.install !== undefined && config.install.length > 0
        ? { install: config.install }
        : undefined,
  });

  const certificate =
    props.domain !== undefined
      ? yield* Certificate("Certificate", {
          app,
          hostname: props.domain,
          kind: "acme",
        })
      : undefined;

  const url = props.domain !== undefined ? `https://${props.domain}` : app.url;

  return { url, app, service, ip, certificate };
});

/**
 * Shared implementation behind the Fly framework website composites:
 * load the framework + node target, run `dev()` under `alchemy dev`
 * (no cloud Service), otherwise `build()` and deploy one Fly.Service
 * with the framework's `serve-node.mjs` as `main` (dist packed as-built).
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 *
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user
 * effect, same as Cloudflare/AWS Website composites.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);

/** Push {@link id} then run {@link makeFrameworkSite}. */
export const frameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => makeFrameworkSite(id, props, config).pipe(Namespace.push(id));
