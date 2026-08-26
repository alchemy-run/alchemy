import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as NodeNet from "node:net";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { asEffect } from "../../Util/types.ts";
import type { Providers } from "../Providers.ts";
import { RecordSet } from "../RecordSet.ts";
import { Server } from "../Server.ts";
import { Service } from "../Service.ts";
import type { Zone } from "../Zone.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

/** Default listen port. Hetzner `deployUnit` curls `/health` whenever `PORT` is set. */
export const DEFAULT_WEBSITE_PORT = 3000;

/**
 * Options for the local dev server that runs a framework site under
 * `alchemy dev`.
 *
 * Use `{ mode: "external" }` to skip starting a dev server entirely —
 * useful when an external dev server (e.g. one you run yourself in
 * another terminal) is serving the site instead.
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
 * Static-asset routing (the Hetzner half of the shared Website
 * vocabulary). Hetzner has no CDN; this only describes miss/HTML
 * handling on the origin unit.
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
 * Props shared by every Hetzner framework website composite.
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
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Process environment for the hosted unit (and the local framework
   * dev server). Not Cloudflare Worker bindings.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`).
   */
  assets?: WebsiteAssetsProps;
  /**
   * Optional custom domain. Creates an A {@link RecordSet} on
   * {@link zone} pointing at the Server's public IPv4. The site `url`
   * becomes `http://{domain}:{port}` (no TLS on Service).
   */
  domain?: string;
  /**
   * Existing Hetzner DNS Zone `domain` is created in. Required when
   * {@link domain} is set — v1 does not provision a Zone.
   */
  zone?: Ref<Zone>;
  /**
   * Server the site's Service runs on. Accepts a `Hetzner.Server` or an
   * Effect that produces one. When omitted, a `cpx12` / `ubuntu-24.04`
   * Server is created in `fsn1` (public IPv4 is the Server default).
   */
  server?: Ref<Server>;
  /**
   * User-defined labels applied to auto-created Server / RecordSet.
   */
  tags?: Record<string, string>;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node container deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: no server modules (or every page prerendered). The
   * composite generates a static-file server as `main`.
   */
  static?:
    | {
        spa?: boolean | undefined;
        errorPage?: string | undefined;
        htmlHandling?: "none" | "drop-trailing-slash" | undefined;
      }
    | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Skip baking `clientDirectory` at `dist/`. Next.js serves `.next`
   * from the unit root instead.
   */
  skipClientAssets?: boolean | undefined;
  /**
   * Native packages to `npm install` into the unit instead of bundling
   * (Next.js needs `next` / `react` / `react-dom`).
   */
  install?: string[] | undefined;
}

export interface Website {
  /**
   * Local framework URL under `alchemy dev`, or the live Service URL
   * (`http://{ipv4}:{port}` / `http://{domain}:{port}`).
   */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /** Server the unit runs on. `undefined` during `alchemy dev`. */
  readonly server: Server | undefined;
  /** Hosted systemd unit. `undefined` during `alchemy dev`. */
  readonly service: Service | undefined;
}

/**
 * The structural slice of a framework-integration module this composite
 * drives. Typed structurally so alchemy carries no dependency on
 * `@distilled.cloud/framework-core` — the *project's* install is always
 * the one loaded.
 */
interface FrameworkModule {
  readonly make: (options: Record<string, unknown>) => Effect.Effect<
    {
      readonly build: (options?: {
        readonly root?: string;
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

/** The structural slice of framework-core's `BuildOutput` this composite reads. */
interface FrameworkBuildOutputSlice {
  readonly distDirectory?: string | undefined;
  readonly clientDirectory: string | undefined;
  readonly serverModules: Array<{ readonly name: string }> | undefined;
}

export class FrameworkSiteError extends Data.TaggedError(
  "Hetzner.Website.FrameworkSiteError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
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

const applyProcessEnv = (
  env: Record<string, string | Redacted.Redacted<string>> | undefined,
) =>
  Effect.sync(() => {
    if (env === undefined) return;
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = Redacted.isRedacted(value)
        ? Redacted.value(value)
        : value;
    }
  });

export const resolveWebsiteServer = Effect.fn(function* (props: {
  readonly server?: Ref<Server> | undefined;
  readonly tags?: Record<string, string> | undefined;
}) {
  if (props.server !== undefined) {
    return yield* asEffect(props.server);
  }
  return yield* Server("Server", {
    serverType: "cpx12",
    image: "ubuntu-24.04",
    location: "fsn1",
    labels: props.tags,
  });
});

export const bindWebsiteDomain = Effect.fn(function* (props: {
  readonly domain: string;
  readonly zone: Ref<Zone>;
  readonly server: Server;
  readonly tags?: Record<string, string> | undefined;
}) {
  const zone = yield* asEffect(props.zone);
  const name = Output.map((apex: string | undefined) => {
    const domain = props.domain;
    if (apex === undefined || domain === apex) return "@";
    const suffix = `.${apex}`;
    if (domain.endsWith(suffix)) return domain.slice(0, -suffix.length);
    throw new Error(
      `Hetzner.Website domain "${domain}" is not inside zone "${apex}"`,
    );
  })(zone.name as never);
  yield* RecordSet("Domain", {
    zone,
    name: name as never,
    type: "A",
    records: [{ value: props.server.ipv4 as never }],
    labels: props.tags,
  });
});

export const websiteUrl = (args: {
  readonly domain?: string | undefined;
  readonly service: Service;
  readonly port: number;
}) =>
  args.domain !== undefined
    ? `http://${args.domain}:${String(args.port)}`
    : args.service.url;

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

/**
 * Shared implementation behind the Hetzner framework website composites:
 * build through the Node deploy target, then host one Service on a
 * Hetzner Server (auto-created `cpx12` in `fsn1` when `server` is omitted).
 *
 * During `alchemy dev` the site is the framework's own dev server and no
 * cloud resources are declared; `Alchemy.remote()` opts back into the
 * live Service path.
 */
const runFrameworkSite = Effect.fn("Hetzner.Website.FrameworkSite")(function* (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = path.resolve(initialCwd, props.rootDir ?? ".");
  const port = DEFAULT_WEBSITE_PORT;

  if (config.static?.spa && config.static.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }
  if (props.domain !== undefined && props.zone === undefined) {
    return yield* Effect.die(
      `Hetzner.Website "${config.name}": "domain" requires "zone" (an existing Hetzner.Zone).`,
    );
  }

  if (isLocal && props.dev?.mode === "external") {
    return {
      url: props.dev.url,
      server: undefined,
      service: undefined,
    };
  }

  const framework = yield* makeFramework(config, root, props.memo);

  if (isLocal) {
    yield* applyProcessEnv(props.env);
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
          message: `The ${config.framework} dev server failed to start`,
          cause,
        }),
    );
    return {
      url,
      server: undefined,
      service: undefined,
    };
  }

  yield* applyProcessEnv(props.env);
  const built = yield* Effect.mapError(
    framework.build({ root }),
    (cause) =>
      new FrameworkSiteError({
        framework: config.framework,
        message: `The ${config.framework} build failed`,
        cause,
      }),
  );

  const distDir = path.resolve(
    built.distDirectory ?? built.clientDirectory ?? path.join(root, "dist"),
  );
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

  const server = yield* resolveWebsiteServer(props);
  const env: Record<string, string> = {
    ...unwrapEnv(props.env),
    PORT: String(port),
  };

  const extraFiles: Array<{ source: string; destination: string }> = [];
  if (config.skipClientAssets) {
    const nextDir = path.join(distDir, ".next");
    if (yield* fs.exists(nextDir).pipe(Effect.orElseSucceed(() => false))) {
      extraFiles.push({ source: nextDir, destination: ".next" });
    }
    const publicDir = path.join(distDir, "public");
    if (yield* fs.exists(publicDir).pipe(Effect.orElseSucceed(() => false))) {
      extraFiles.push({ source: publicDir, destination: "public" });
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
        extraFiles.push({ source: configPath, destination: name });
      }
    }
  } else {
    extraFiles.push({ source: distDir, destination: "." });
  }

  const service = yield* Service("Service", {
    server,
    main,
    extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
    port,
    env,
    isExternal: true,
    build:
      config.install !== undefined && config.install.length > 0
        ? { install: config.install }
        : undefined,
  });

  if (props.domain !== undefined && props.zone !== undefined) {
    yield* bindWebsiteDomain({
      domain: props.domain,
      zone: props.zone,
      server,
      tags: props.tags,
    });
  }

  return {
    url: websiteUrl({ domain: props.domain, service, port }),
    server,
    service,
  };
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);
