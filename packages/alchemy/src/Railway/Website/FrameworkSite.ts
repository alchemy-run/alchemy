import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as NodeNet from "node:net";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { PackageInstall } from "../../Bundle/InstalledPackages.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { asEffect } from "../../Util/types.ts";
import { CustomDomain } from "../CustomDomain.ts";
import { RegistryRequired, type ExtraFile } from "../hosted.ts";
import { Project, type Project as ProjectResource } from "../Project.ts";
import type { Providers } from "../Providers.ts";
import { Service, type Service as ServiceResource } from "../Service.ts";

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
   * Registry prefix to push the site image to (`ghcr.io/org`,
   * `docker.io/user`). Required on deploy when the site builds a `main`
   * (always, on the live path). Unused under `alchemy dev`.
   */
  registry?: string;
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
   * Native packages to `bun install` into the image instead of bundling
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
  url: string | undefined;
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

const relativeToCwd = (abs: string): string => {
  const relative = abs.startsWith(initialCwd)
    ? abs.slice(initialCwd.length).replace(/^[/\\]+/, "")
    : abs;
  return relative.length > 0 ? relative : ".";
};

/**
 * Generate a complete Node/Bun HTTP program: `/health`, GET static assets
 * from `CLIENT_DIR`, SPA / 404 fallback. No package imports other than
 * `node:*`. After Railway bundles this as `/app/index.mjs`, `./dist/`
 * resolves to `/app/dist`.
 */
export const makeStaticServeSource = (options: {
  readonly clientDirExpression: string;
  readonly spa?: boolean | undefined;
  readonly errorPage?: string | undefined;
  readonly htmlHandling?: "none" | "drop-trailing-slash" | undefined;
}): string => {
  const dropSlash = options.htmlHandling === "drop-trailing-slash";
  const spa = options.spa === true;
  const errorPage =
    options.errorPage !== undefined && options.errorPage.length > 0
      ? options.errorPage.replace(/^\/+/, "")
      : undefined;
  return `// Generated by Railway.Website — Node container static serve entry.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number.parseInt(process.env.PORT ?? "${String(WEBSITE_PORT)}", 10);
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
    errorPage !== undefined
      ? `      const notFound = lookupStatic(${JSON.stringify(`/${errorPage}`)});
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
  }      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  })().catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : PORT;
  const host = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log("http://" + host + ":" + port);
});
`;
};

const CLIENT_DIR_RE = /const CLIENT_DIR = [\s\S]*?;/;

const rewriteClientDir = (source: string): string | undefined => {
  if (!CLIENT_DIR_RE.test(source)) return undefined;
  return source.replace(
    CLIENT_DIR_RE,
    `const CLIENT_DIR = fileURLToPath(new URL("./dist/", import.meta.url));`,
  );
};

const collectBakeFiles = Effect.fn(function* (
  root: string,
  clientDirectory: string | undefined,
  bake: "client" | "next",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (bake === "next") {
    const files: ExtraFile[] = [];
    const nextDir = path.join(root, ".next");
    if (yield* fs.exists(nextDir)) {
      files.push({ source: relativeToCwd(nextDir), dest: ".next" });
    }
    const publicDir = path.join(root, "public");
    if (yield* fs.exists(publicDir)) {
      files.push({ source: relativeToCwd(publicDir), dest: "public" });
    }
    for (const name of [
      "next.config.js",
      "next.config.mjs",
      "next.config.cjs",
      "next.config.ts",
    ] as const) {
      const configPath = path.join(root, name);
      if (yield* fs.exists(configPath)) {
        files.push({ source: relativeToCwd(configPath), dest: name });
      }
    }
    return files;
  }
  if (clientDirectory === undefined) return [] as ExtraFile[];
  return [
    {
      source: relativeToCwd(path.resolve(clientDirectory)),
      dest: "dist",
    },
  ] satisfies ExtraFile[];
});

const writeServeEntry = Effect.fn(function* (input: {
  readonly distDir: string;
  readonly clientDirectory: string | undefined;
  readonly serverEntry: string | undefined;
  readonly bake: "client" | "next";
  readonly static: WebsiteStaticConfig | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.serverEntry !== undefined) {
    if (input.bake === "next") {
      return relativeToCwd(input.serverEntry);
    }
    const source = yield* fs.readFileString(input.serverEntry);
    const rewritten = rewriteClientDir(source);
    if (rewritten === undefined) {
      return relativeToCwd(input.serverEntry);
    }
    const servePath = path.join(
      path.dirname(input.serverEntry),
      "alchemy-serve.mjs",
    );
    yield* fs.writeFileString(servePath, rewritten);
    return relativeToCwd(servePath);
  }
  const clientAbs =
    input.clientDirectory !== undefined
      ? path.resolve(input.clientDirectory)
      : input.distDir;
  const servePath = path.join(path.dirname(clientAbs), "alchemy-serve.mjs");
  const source = makeStaticServeSource({
    clientDirExpression: `fileURLToPath(new URL("./dist/", import.meta.url))`,
    spa: input.static?.spa,
    errorPage: input.static?.errorPage,
    htmlHandling: input.static?.htmlHandling,
  });
  yield* fs.writeFileString(servePath, source);
  return relativeToCwd(servePath);
});

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
export const makeFrameworkSite = Effect.fn("Railway.Website.FrameworkSite")(
  function* (
    _id: string,
    props: FrameworkSiteProps,
    config: FrameworkSiteConfig,
  ) {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;
    const path = yield* Path.Path;
    const root = path.resolve(initialCwd, props.rootDir ?? ".");
    const bake = config.bake ?? "client";

    if (isLocal) {
      if (props.dev?.mode === "external") {
        return {
          url: props.dev.url,
          service: undefined,
          project: undefined,
        } satisfies Website;
      }
      yield* applyProcessEnv(props.env);
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

    const registry = props.registry;
    if (registry === undefined || registry.length === 0) {
      return yield* new RegistryRequired({
        message:
          `Railway.Website.${config.name} requires \`registry\` ` +
          "(GHCR / Docker Hub prefix Railway can pull) on deploy.",
      });
    }

    const framework = yield* makeFramework(config, root);
    const built = yield* Effect.mapError(
      framework.build({ root }),
      (cause) =>
        new FrameworkServerError({
          framework: config.framework,
          message: `The ${config.name} build failed`,
          cause,
        }),
    );
    const distDir = path.resolve(
      built.distDirectory ?? path.join(root, "dist"),
    );
    const entryName = built.serverModules?.[0]?.name;
    const serverEntry =
      entryName !== undefined ? path.resolve(distDir, entryName) : undefined;
    const main = yield* writeServeEntry({
      distDir,
      clientDirectory: built.clientDirectory,
      serverEntry,
      bake,
      static: config.static,
    });
    const extraFiles = yield* collectBakeFiles(
      root,
      built.clientDirectory,
      bake,
    );

    const project = yield* asEffect(props.project ?? Project("Project"));
    const service = yield* Service("Service", {
      project,
      main,
      registry,
      port: WEBSITE_PORT,
      healthcheck: "/health",
      env: envRecord(props.env),
      extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
      build:
        config.install !== undefined ? { install: config.install } : undefined,
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
  },
);
