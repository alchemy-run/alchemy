/**
 * Dev-server delivery of an effectful `Website.SvelteKit`'s Effect fetch
 * (DESIGN §6.2b / §8): kit dev is Node SSR, so the production worker shim
 * (and its effect arm) never exists in dev. Instead, a `configureServer`
 * middleware mounted IN FRONT of kit runs the Effect fetch for
 * `server.routes` — restoring the "effect before kit" routing parity the
 * deployed shim has — and falls through to kit (`next()`) on passthrough
 * or miss.
 *
 * - The user's site module and the `alchemy/serve` bridge are loaded
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
   * Path globs the Effect fetch owns (`server.routes`). Omitted =
   * middleware mode (every request offered to the effect fetch first).
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
  const routes = args.effect.routes;
  const stack = args.effect.stack;
  return {
    name: "alchemy-sveltekit-effect-dev",
    apply: "serve",
    enforce: "pre",
    // One alchemy instance for the whole dev server: the site module's
    // alchemy imports and the virtual module's `alchemy/serve` both
    // resolve through the host runtime instead of a vite-transformed
    // (linked-workspace) copy of the alchemy graph.
    config: () => ({ ssr: { external: ["alchemy"] } }),
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined),
    load: (id) =>
      id === RESOLVED_VIRTUAL_ID
        ? [
            `import Site from ${JSON.stringify(mainPath)};`,
            `import { make } from "alchemy/serve";`,
            `export const handle = make(Site);`,
            `export default Site;`,
          ].join("\n")
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
          if (
            routes !== undefined &&
            !matchServerRoutes(routes, url.pathname)
          ) {
            next();
            return;
          }
          // Through the module runner so site.ts edits hot-invalidate.
          const mod = (await server.ssrLoadModule(
            VIRTUAL_ID,
          )) as unknown as VirtualEffectModule;
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
          const response = await mod.handle.match(toWebRequest(req, url), {
            env,
          });
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
