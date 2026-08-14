/**
 * Dev-server delivery of an effectful `Website.SvelteKit`'s Effect fetch
 * (DESIGN §6.2b / §8): kit dev is Node SSR, so the production worker shim
 * (and its effect arm) never exists in dev. Instead, a `configureServer`
 * middleware mounted IN FRONT of kit runs the Effect fetch for
 * `server.routes` — restoring the "effect before kit" routing parity the
 * deployed shim has. Strict route ownership: inside the routes the effect
 * fetch's answer (404s included) is final; only paths outside the routes
 * fall through to kit (`next()`).
 *
 * - The user's site module and the `alchemy/Serve` bridge are loaded
 *   through a virtual module in the Vite dev-server graph, so editing
 *   `site.ts` hot-invalidates the module chain and the next request
 *   rebuilds the Effect layer stack against the fresh class (server-side
 *   HMR for effect code).
 * - `alchemy` itself is forced `ssr.external` so the site module, the
 *   bridge, and everything they pull share ONE module instance loaded by
 *   the host runtime (bun under `alchemy dev`), instead of a
 *   vite-transformed copy of the whole alchemy graph.
 * - Env comes from the same platform proxy the adapter's `emulate()`
 *   serves to kit (`platform.env` — the Worker's real local bindings
 *   through workerd), overlaid with the alchemy stack markers the
 *   deployed worker gets from `putWorker`, so the bridge's four-worlds
 *   guard and Stack/Config layers resolve exactly as in prod.
 *
 * This module is Vite-plugin callback code (like `UserConfig.ts`), not an
 * Effect service.
 */
import * as NodeFs from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type * as ViteModule from "vite";

/**
 * Effectful (wrapper) delivery options for a SvelteKit build/dev
 * invocation — plain data assembled by alchemy's SvelteKit source provider
 * from the construct's collect-only stamp.
 */
export interface SvelteKitEffectOptions {
  /**
   * The user's site module (the impl anchor, `main: import.meta.url`) as
   * an absolute path or `file://` URL.
   */
  readonly main: string;
  /**
   * Path globs the Effect fetch owns (`server.routes`). Requests outside
   * them are kit's; inside them the effect fetch is authoritative.
   * @default ["/api/*"]
   */
  readonly routes?: ReadonlyArray<string> | undefined;
  /** Durable Object class names from the site's exports (build only). */
  readonly durableObjects?: ReadonlyArray<string> | undefined;
  /** Workflow class names from the site's exports (build only). */
  readonly workflows?: ReadonlyArray<string> | undefined;
  /** Stack identity (markers for the dev env; baked into wf bridges). */
  readonly stack?:
    | { readonly name: string; readonly stage: string }
    | undefined;
}

/** Convert the `main` anchor (path or `file://` URL) to an absolute path. */
export const effectMainPath = (main: string): string =>
  main.startsWith("file://") ? fileURLToPath(main) : NodePath.resolve(main);

/**
 * `server.routes` glob matching — the `assets.runWorkerFirst` dialect:
 * `*` matches any run of characters (including `/`), a leading `!` marks
 * an exclusion, and exclusions take precedence. A copy of alchemy's
 * `Serve/Routes.ts` (this package carries no alchemy dependency).
 */
export const matchServerRoutes = (
  routes: ReadonlyArray<string>,
  pathname: string,
): boolean => {
  const toRegExp = (glob: string): RegExp =>
    new RegExp(
      `^${glob
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
  for (const route of routes) {
    if (route.startsWith("!") && toRegExp(route.slice(1)).test(pathname)) {
      return false;
    }
  }
  for (const route of routes) {
    if (!route.startsWith("!") && toRegExp(route).test(pathname)) {
      return true;
    }
  }
  return false;
};

/**
 * Signals of an explicit `alchemy/Serve` mount inside kit's built server
 * graph (`hooks.server.ts` importing `alchemy/SvelteKit`'s `toHandle`
 * etc.): either the explicit-MOUNT marker byte literal (embedded by
 * `alchemy/src/Serve/Serve.ts`, the module only explicit mounts import,
 * when it was bundled into the output) or an import of an `alchemy/Serve`
 * specifier (kit's Vite SSR build externalizes deps, leaving the specifier
 * in the emitted chunks). Deliberately NOT the bridge's
 * `__ALCHEMY_SERVE_v1__` sentinel: the bridge module also rides the
 * value-form `createClient` graph (`+page.server.ts` importing the
 * backend), so its literal appears in EVERY effectful website's kit server
 * bundle and would false-positive the stand-down. Kept in sync with
 * `alchemy/src/Serve/constants.ts` — duplicated here because this package
 * deliberately carries no alchemy dependency.
 */
const SERVE_MOUNT_PATTERN =
  /__ALCHEMY_SERVE_MOUNT_v1__|["']alchemy\/(?:Serve(?:\/Worker)?|Next|Nitro|Astro|SvelteKit)["']/;

/**
 * Scan kit's built server directory for an explicit `alchemy/Serve` mount
 * (DESIGN §6.3: auto tier stands down when the user mounted the bridge
 * themselves). Synchronous framework-callback code, shared by the
 * Cloudflare and AWS adapters — cloud-agnostic, so it lives here rather
 * than in a platform target module.
 */
export const scanForExplicitServeMount = (directory: string): boolean => {
  let entries: NodeFs.Dirent[];
  try {
    entries = NodeFs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (scanForExplicitServeMount(child)) {
        return true;
      }
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      try {
        if (SERVE_MOUNT_PATTERN.test(NodeFs.readFileSync(child, "utf8"))) {
          return true;
        }
      } catch {
        // unreadable file — keep scanning
      }
    }
  }
  return false;
};

/** The subset of a kit `Emulator` the middleware needs. */
interface EmulatorLike {
  readonly platform?: (details: {
    config: unknown;
    prerender: boolean;
  }) => unknown;
}

export interface EffectDevPluginArgs {
  readonly effect: SvelteKitEffectOptions;
  /**
   * Access to the adapter's dev emulator (the platform proxy). Called per
   * request; the emulator memoizes the proxy internally.
   */
  readonly emulate: () => EmulatorLike | Promise<EmulatorLike> | undefined;
  /**
   * The deploy target's platform id (`DeployTarget.platform`). Selects the
   * serve bridge the virtual module mounts:
   *
   * - `"aws"` — `makeWebsiteHandlers` (alchemy's AWS Lambda serve shell):
   *   env resolves from `process.env` (the sidecar process `alchemy dev`
   *   lowered the packed binding env + stack markers into) and the layer
   *   recipe carries `Credentials.fromChain()` / `Region.fromEnv()`, so
   *   dev bindings hit the real cloud with the developer's ambient
   *   profile — the AWS dev model.
   * - anything else (default) — `alchemy/Serve`'s `make`, with env served
   *   by the adapter's platform proxy ({@link emulate}).
   */
  readonly platform?: string | undefined;
}

const VIRTUAL_ID = "virtual:alchemy-sveltekit-effect";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

/** The `ServeHandle` shape of the virtual module's `handle` export. */
interface VirtualEffectModule {
  readonly handle: {
    match(
      request: Request,
      options?: {
        env?: unknown;
        waitUntil?: (promise: Promise<unknown>) => void;
      },
    ): Promise<Response | undefined>;
  };
}

const toWebRequest = (req: NodeHttp.IncomingMessage, url: URL): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url.href, {
    method,
    headers,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as unknown as RequestInit["body"],
          // Required for streaming request bodies (undici/bun fetch).
          duplex: "half",
        }
      : undefined),
  } as RequestInit);
};

const sendWebResponse = async (
  res: NodeHttp.ServerResponse,
  response: Response,
): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      res.setHeader(name, value);
    }
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }
  if (response.body === null) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    res.on("error", reject);
    res.on("finish", () => resolve());
    stream.pipe(res);
  });
};

/**
 * The dev plugin: virtual serve-handle module + the front middleware.
 * `apply: "serve"` — never part of a production build (the worker shim's
 * effect arm owns prod).
 */
export const makeEffectDevPlugin = (
  args: EffectDevPluginArgs,
): ViteModule.Plugin => {
  const mainPath = effectMainPath(args.effect.main);
  // Mirrors alchemy's DEFAULT_SERVER_ROUTES (this package carries no
  // alchemy dependency).
  const routes = args.effect.routes ?? ["/api/*"];
  const stack = args.effect.stack;
  const isAws = args.platform === "aws";
  return {
    name: "alchemy-sveltekit-effect-dev",
    apply: "serve",
    enforce: "pre",
    // One alchemy instance for the whole dev server: the site module's
    // alchemy imports and the virtual module's serve bridge both
    // resolve through the host runtime instead of a vite-transformed
    // (linked-workspace) copy of the alchemy graph. Under a bun host
    // (the `alchemy dev` sidecar), externalized imports resolve with the
    // `bun` condition FIRST so alchemy (and distilled) load from `src` —
    // mirroring the test runner and `FunctionBundle`: a fresh workspace
    // never silently exercises a stale `lib` build.
    config: () => ({
      ssr: {
        external: ["alchemy"],
        // Under a bun host (the `alchemy dev` sidecar), resolve alchemy
        // (and distilled) with the `bun` condition FIRST so they load from
        // `src` — mirroring the test runner and `FunctionBundle`: a fresh
        // workspace never silently exercises a stale `lib` build. The
        // remaining conditions are vite's server defaults.
        ...(typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
          ? {
              resolve: {
                conditions: ["bun", "module", "node", "development|production"],
                externalConditions: ["bun", "node"],
              },
            }
          : undefined),
      },
    }),
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined),
    load: (id) =>
      id === RESOLVED_VIRTUAL_ID
        ? (isAws
            ? [
                `import Site from ${JSON.stringify(mainPath)};`,
                `import { makeWebsiteHandlers } from "alchemy/AWS/Lambda/WebsiteHandlers";`,
                // Env resolves from process.env (the sidecar process the
                // dev server runs in — `alchemy dev` lowered the packed
                // binding env + stack markers into it). The middleware
                // gates `server.routes` before dispatching, so the
                // handlers claim everything they receive — a default
                // claim here would shadow a broader construct claim.
                `export const handle = makeWebsiteHandlers({ site: Site, routes: ["/*"] });`,
                `export default Site;`,
              ]
            : [
                `import Site from ${JSON.stringify(mainPath)};`,
                `import { make } from "alchemy/Serve";`,
                // The middleware gates `server.routes` before dispatching
                // — the handle claims everything it receives.
                `export const handle = make(Site, { routes: ["/*"] });`,
                `export default Site;`,
              ]
          ).join("\n")
        : undefined,
    configureServer(server) {
      // Mounted synchronously in `configureServer`, so it runs BEFORE
      // kit's own middleware (kit mounts in the deferred post hook) —
      // the dev analogue of the shim dispatching effect routes before
      // the cache/asset checks.
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
          );
          // Raw pathname, matching the deployed wrapper's dispatch
          // (`makeWebsiteExports` matches `new URL(url).pathname`).
          // Strict route ownership: only paths outside `server.routes`
          // fall through to kit.
          if (!matchServerRoutes(routes, url.pathname)) {
            next();
            return;
          }
          // Through the module runner so site.ts edits hot-invalidate.
          const mod = (await server.ssrLoadModule(
            VIRTUAL_ID,
          )) as unknown as VirtualEffectModule;
          let response: Response | undefined;
          if (isAws) {
            // AWS: `makeWebsiteHandlers` resolves env from `process.env`
            // itself (the sidecar process carries the lowered binding env
            // + stack markers) — no platform proxy exists on this target.
            response = await mod.handle.match(toWebRequest(req, url));
          } else {
            const emulator = await args.emulate();
            const platform = (await emulator?.platform?.({
              config: {},
              prerender: false,
            })) as { env?: Record<string, unknown> } | undefined;
            const env: Record<string, unknown> = {
              ...platform?.env,
              // The markers `putWorker` appends in prod — the bridge's
              // four-worlds guard and Stack layer key off them.
              ...(stack !== undefined
                ? {
                    ALCHEMY_PHASE: "runtime",
                    ALCHEMY_STACK_NAME: stack.name,
                    ALCHEMY_STAGE: stack.stage,
                  }
                : undefined),
            };
            response = await mod.handle.match(toWebRequest(req, url), {
              env,
            });
          }
          if (response === undefined) {
            next();
            return;
          }
          await sendWebResponse(res, response);
        })().catch(next);
      });
    },
  };
};
