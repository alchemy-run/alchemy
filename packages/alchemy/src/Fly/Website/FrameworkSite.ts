import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import type { Output } from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { App } from "../App.ts";
import { Certificate } from "../Certificate.ts";
import { IpAssignment } from "../IpAssignment.ts";
import type { Providers } from "../Providers.ts";
import { Service } from "../Service.ts";

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
   * Assets-only mode: generate a static-file server when the build has
   * no `serverModules` (or this is set). `spa` falls back to
   * `index.html`; `errorPage` serves that file with 404.
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Packages installed into the Machine image with `bun install` instead
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

interface FrameworkService {
  readonly build: (options?: {
    readonly root?: string;
  }) => Effect.Effect<FrameworkBuildOutputSlice, unknown>;
  readonly dev: (options?: {
    readonly root?: string;
    readonly port?: number;
    readonly host?: string;
  }) => Effect.Effect<{ readonly url: string }, unknown, Scope.Scope>;
}

interface FrameworkModule {
  readonly make: (
    options: Record<string, unknown>,
  ) =>
    | Effect.Effect<
        FrameworkService,
        unknown,
        FileSystem.FileSystem | Path.Path
      >
    | Layer.Layer<unknown, unknown, FileSystem.FileSystem | Path.Path>;
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

const CONTAINER_CLIENT_DIR = "/app/dist";
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
  options: Record<string, unknown> | undefined,
) =>
  importFrameworkModule(config.framework).pipe(
    Effect.flatMap((module_) => {
      const made = module_.make({
        ...options,
        root,
        target: config.target,
      });
      const failInit = (cause: unknown) =>
        new FrameworkSiteError({
          framework: config.framework,
          message: "Failed to initialize the framework integration",
          cause,
        });
      if (Layer.isLayer(made)) {
        return Effect.tryPromise({
          try: () =>
            import("@alchemy.run/frontend-frameworks/core") as Promise<{
              Framework: Effect.Effect<FrameworkService>;
            }>,
          catch: failInit,
        }).pipe(
          Effect.flatMap((core) =>
            Effect.mapError(
              Effect.provide(
                core.Framework as never,
                made as never,
              ) as Effect.Effect<FrameworkService, unknown>,
              failInit,
            ),
          ),
        );
      }
      return Effect.mapError(made, failInit);
    }),
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

const notFoundHandlingOf = (
  config: FrameworkSiteConfig,
): "none" | "spa" | "404-page" => {
  if (config.static?.errorPage !== undefined) return "404-page";
  if (config.static?.spa === true) return "spa";
  return "none";
};

/**
 * Generate a complete Node/Bun HTTP program: `/health`, GET static
 * assets, then 404. Used when the framework build has no server modules.
 */
export const makeStaticServeEntrySource = (options: {
  readonly clientDirExpression: string;
  readonly htmlHandling?: "none" | "drop-trailing-slash";
  readonly notFoundHandling?: "none" | "spa" | "404-page";
  readonly errorPage?: string;
  readonly printUrl?: boolean;
  readonly defaultPort?: number;
}): string => {
  const port = options.defaultPort ?? DEFAULT_PORT;
  const htmlHandling = options.htmlHandling ?? "none";
  const notFoundHandling = options.notFoundHandling ?? "none";
  const dropSlash = htmlHandling === "drop-trailing-slash";
  const spa = notFoundHandling === "spa";
  const notFoundPage = notFoundHandling === "404-page";
  const errorPage = options.errorPage ?? "404.html";
  const listen = options.printUrl
    ? `server.listen(PORT, HOST, () => {
  const printed = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log("http://" + printed + ":" + PORT);
});
`
    : `server.listen(PORT, HOST);
`;

  return `// Generated by Fly.Website — Node container static serve entry.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number.parseInt(process.env.PORT ?? "${String(port)}", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLIENT_DIR = ${options.clientDirExpression};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const existingFile = (filePath) => {
  try {
    const st = fs.statSync(filePath);
    if (st.isFile()) return filePath;
    if (st.isDirectory()) {
      const index = path.join(filePath, "index.html");
      try {
        if (fs.statSync(index).isFile()) return index;
      } catch {}
    }
  } catch {}
  return undefined;
};

const safeJoin = (urlPath) => {
  const relative = urlPath.replace(/^\\/+/, "");
  const resolved = path.resolve(CLIENT_DIR, relative);
  const root = path.resolve(CLIENT_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return undefined;
  }
  return resolved;
};

const lookupStatic = (urlPath) => {
  const base = safeJoin(urlPath);
  if (base === undefined) return undefined;
  const direct = existingFile(base);
  if (direct) return direct;
${
  dropSlash
    ? `  if (!path.extname(base)) {
    const html = existingFile(base + ".html");
    if (html) return html;
  }
`
    : ""
}  return undefined;
};

const sendFile = (res, filePath, status) => {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(status, {
    "content-type": MIME[ext] ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
};

const pathnameOf = (url) => {
  try {
    return decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  } catch {
    return "/";
  }
};

const server = http.createServer((req, res) => {
  void (async () => {
    const urlPath = pathnameOf(req.url ?? "/");
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      urlPath === "/health"
    ) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const file = lookupStatic(urlPath);
      if (file !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(200);
          res.end();
          return;
        }
        sendFile(res, file, 200);
        return;
      }
${
  spa
    ? `      const spaIndex = lookupStatic("/index.html");
      if (spaIndex !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(200);
          res.end();
          return;
        }
        sendFile(res, spaIndex, 200);
        return;
      }
`
    : ""
}${
    notFoundPage
      ? `      const notFound = lookupStatic(${JSON.stringify(`/${errorPage.replace(/^\/+/, "")}`)});
      if (notFound !== undefined) {
        if (req.method === "HEAD") {
          res.writeHead(404);
          res.end();
          return;
        }
        sendFile(res, notFound, 404);
        return;
      }
`
      : ""
  }    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  })().catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  });
});

${listen}`;
};

export const writeStaticServeEntry = Effect.fn(function* (options: {
  readonly filePath: string;
  readonly clientDirExpression: string;
  readonly htmlHandling?: "none" | "drop-trailing-slash";
  readonly notFoundHandling?: "none" | "spa" | "404-page";
  readonly errorPage?: string;
  readonly printUrl?: boolean;
  readonly defaultPort?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(options.filePath), {
    recursive: true,
  });
  yield* fs.writeFileString(
    options.filePath,
    makeStaticServeEntrySource(options),
  );
  return options.filePath;
});

const rewriteClientDir = Effect.fn(function* (servePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(servePath);
  if (!source.includes("const CLIENT_DIR =")) return servePath;
  const rewritten = source.replace(
    /const CLIENT_DIR = [^;]+;/,
    `const CLIENT_DIR = ${JSON.stringify(CONTAINER_CLIENT_DIR)};`,
  );
  const out = path.join(path.dirname(servePath), "serve-fly.mjs");
  yield* fs.writeFileString(out, rewritten);
  return out;
});

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

/**
 * Shared implementation behind the Fly framework website composites:
 * load the framework + node target, run `dev()` under `alchemy dev`
 * (no cloud Service), otherwise `build()` and deploy one Fly.Service
 * with the node serve entry as `main` and `clientDirectory` baked
 * into the image.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do).
 */
export const makeFrameworkSite = Effect.fn("Fly.Website.FrameworkSite")(
  function* (
    _id: string,
    props: FrameworkSiteProps,
    config: FrameworkSiteConfig,
  ): Effect.Effect<FrameworkSite, FrameworkSiteError, any> {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = path.resolve(initialCwd, props.rootDir ?? ".");

    if (isLocal) {
      if (props.dev?.mode === "external") {
        return {
          url: props.dev.url,
          app: undefined,
          service: undefined,
          ip: undefined,
          certificate: undefined,
        };
      }
      yield* applyProcessEnv(props.env);
      const service = yield* makeFramework(config, root, config.options);
      const host =
        props.dev && props.dev.mode !== "external" ? props.dev.host : undefined;
      const preferredPort =
        props.dev && props.dev.mode !== "external" ? props.dev.port : undefined;
      const port =
        preferredPort !== undefined
          ? yield* resolveDevPort({
              framework: config.framework,
              port: preferredPort,
              host: host ?? "127.0.0.1",
              strictPort:
                props.dev !== undefined && props.dev.mode !== "external"
                  ? (props.dev.strictPort ?? false)
                  : false,
            })
          : undefined;
      const scope = yield* Effect.serviceOption(Scope.Scope).pipe(
        Effect.flatMap((option) =>
          Option.isSome(option) ? Effect.succeed(option.value) : Scope.make(),
        ),
      );
      const { url } = yield* Effect.mapError(
        service
          .dev({ root, port, host })
          .pipe(Effect.provideService(Scope.Scope, scope)),
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
      };
    }

    const framework = yield* makeFramework(config, root, config.options);
    const built = yield* Effect.mapError(
      framework.build({ root }),
      (cause) =>
        new FrameworkSiteError({
          framework: config.framework,
          message: `The ${config.name} build failed`,
          cause,
        }),
    );

    const distDir = built.distDirectory ?? path.join(root, "dist");
    const clientDir =
      built.clientDirectory !== undefined
        ? path.resolve(built.clientDirectory)
        : undefined;
    const entryName = built.serverModules?.[0]?.name;
    const assetsOnly =
      config.static !== undefined ||
      entryName === undefined ||
      entryName.length === 0;

    let main: string;
    if (assetsOnly) {
      if (clientDir === undefined) {
        return yield* Effect.fail(
          new FrameworkSiteError({
            framework: config.framework,
            message: `The ${config.name} build produced no client assets`,
          }),
        );
      }
      const servePath = path.join(path.dirname(clientDir), "serve-fly.mjs");
      main = yield* writeStaticServeEntry({
        filePath: servePath,
        clientDirExpression: JSON.stringify(CONTAINER_CLIENT_DIR),
        htmlHandling: config.htmlHandling,
        notFoundHandling: notFoundHandlingOf(config),
        errorPage: config.static?.errorPage,
      });
    } else {
      const servePath = path.resolve(distDir, entryName);
      if (!(yield* fs.exists(servePath))) {
        return yield* Effect.fail(
          new FrameworkSiteError({
            framework: config.framework,
            message: `The ${config.name} build produced no server entry at ${servePath}`,
          }),
        );
      }
      main = yield* rewriteClientDir(servePath);
    }

    const extraFiles: Array<{ source: string; dest: string }> = [];
    if (!config.skipClientAssets && clientDir !== undefined) {
      extraFiles.push({ source: clientDir, dest: "dist" });
    }
    if (config.skipClientAssets) {
      const nextDir = path.join(distDir, ".next");
      if (yield* fs.exists(nextDir).pipe(Effect.orElseSucceed(() => false))) {
        extraFiles.push({ source: nextDir, dest: ".next" });
      }
      const publicDir = path.join(distDir, "public");
      if (yield* fs.exists(publicDir).pipe(Effect.orElseSucceed(() => false))) {
        extraFiles.push({ source: publicDir, dest: "public" });
      }
    }

    const app =
      props.app !== undefined
        ? yield* resolveRef(props.app)
        : yield* App("App");

    const ip = yield* IpAssignment("Shared", {
      app,
      type: "shared_v4",
    });

    const service = yield* Service("Service", {
      app,
      main,
      port: DEFAULT_PORT,
      env: props.env,
      extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
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

    const url =
      props.domain !== undefined ? `https://${props.domain}` : app.url;

    return { url, app, service, ip, certificate };
  },
);

/** Push {@link id} then run {@link makeFrameworkSite}. */
export const frameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => makeFrameworkSite(id, props, config).pipe(Namespace.push(id));
