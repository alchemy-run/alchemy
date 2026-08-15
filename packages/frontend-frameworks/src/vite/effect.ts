/**
 * Effectful (wrapper) delivery for the generic Vite integration — the
 * plain-data descriptor plus the dev-server middleware that restores the
 * "effect before framework" routing parity `alchemy dev` needs.
 *
 * Production delivery lives in the deploy target (`./aws.ts` composes the
 * effect fetch ahead of the framework handler inside the generated Lambda
 * entry). Dev delivery lives here: a `configureServer` middleware mounted
 * IN FRONT of the framework's own Vite dev server runs the Effect fetch
 * for `server.routes`. Strict route ownership: inside the routes the
 * effect fetch's answer (404s included) is final; only paths outside the
 * routes fall through to the framework (`next()`).
 *
 * - The user's site module and the serve bridge are loaded through a
 *   virtual module in the Vite dev-server graph, so editing the site
 *   module hot-invalidates the chain and the next request rebuilds the
 *   Effect layer stack against the fresh class.
 * - `alchemy` itself is forced `ssr.external` so the site module, the
 *   bridge, and everything they pull share ONE module instance loaded by
 *   the host runtime instead of a vite-transformed copy of the whole
 *   alchemy graph.
 *
 * This module is Vite-plugin callback code, not an Effect service. It is
 * self-contained by convention (each framework directory carries its own
 * effect helpers; this package deliberately has no alchemy dependency).
 */
import * as NodeFs from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type * as ViteModule from "vite";

/**
 * Effectful (wrapper) delivery options for a Vite build/dev invocation —
 * plain data assembled by alchemy's Vite composite from the construct's
 * collect-only stamp (`effectOptions` on the FrameworkSite config).
 */
export interface ViteEffectOptions {
  /**
   * The user's site module (the impl anchor, `main: import.meta.url`) as
   * an absolute path or `file://` URL.
   */
  readonly main: string;
  /**
   * Path globs the Effect fetch owns (`server.routes`). Requests outside
   * them are the framework's; inside them the effect fetch is
   * authoritative.
   * @default ["/api/*"]
   */
  readonly routes?: ReadonlyArray<string> | undefined;
  /** Stack identity (markers for the dev env). */
  readonly stack?:
    | { readonly name: string; readonly stage: string }
    | undefined;
}

/**
 * Convert the `main` anchor (path or `file://` URL) to a forward-slash
 * absolute path. The anchor arrives absolute from the construct
 * (`main: import.meta.url`), so it is used VERBATIM apart from the URL
 * unwrap — `NodePath.resolve` would prepend a drive letter on Windows and
 * emit backslashes, which are invalid in the generated ESM import
 * specifiers (vite and rolldown both want `C:/...` style there).
 */
export const effectMainPath = (main: string): string =>
  (main.startsWith("file://") ? fileURLToPath(main) : main).replaceAll(
    "\\",
    "/",
  );

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
 * Signals of an explicit `alchemy/Serve` mount inside the framework's
 * built server graph: either the explicit-MOUNT marker byte literal
 * (embedded by `alchemy/src/Serve/Serve.ts`, the module only explicit
 * mounts import, when it was bundled into the output) or an import of an
 * `alchemy/Serve` specifier (Vite SSR builds externalize deps, leaving
 * the specifier in the emitted chunks). Kept in sync with
 * `alchemy/src/Serve/constants.ts` — duplicated here because this package
 * deliberately carries no alchemy dependency. (Same pattern as the
 * SvelteKit and Nuxt adapters' stand-down scan.)
 */
const SERVE_MOUNT_PATTERN =
  /__ALCHEMY_SERVE_MOUNT_v1__|["']alchemy\/(?:Serve(?:\/Worker)?|Next|Nitro|Astro|SvelteKit)["']/;

/**
 * Scan the built server directory for an explicit `alchemy/Serve` mount
 * (DESIGN §6.3: the auto-inject tier stands down when the user mounted
 * the bridge themselves — the explicit tier always wins, never two
 * bridges on one Lambda). Synchronous framework-callback code.
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

export interface EffectDevPluginArgs {
  readonly effect: ViteEffectOptions;
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
   *   from `process.env` overlaid with the alchemy stack markers.
   */
  readonly platform?: string | undefined;
}

const VIRTUAL_ID = "virtual:alchemy-vite-effect";
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
 * `apply: "serve"` — never part of a production build (the deploy
 * target's generated Lambda entry owns prod).
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
    name: "alchemy-vite-effect-dev",
    apply: "serve",
    enforce: "pre",
    // One alchemy instance for the whole dev server: the site module's
    // alchemy imports and the virtual module's serve bridge both resolve
    // through the host runtime instead of a vite-transformed
    // (linked-workspace) copy of the alchemy graph. Under a bun host
    // (the `alchemy dev` sidecar), externalized imports resolve with the
    // `bun` condition FIRST so alchemy (and distilled) load from `src` —
    // mirroring the test runner and `FunctionBundle`: a fresh workspace
    // never silently exercises a stale `lib` build.
    config: () => ({
      ssr: {
        external: ["alchemy"],
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
      // Mounted synchronously in `configureServer`, so it runs BEFORE the
      // framework's own middleware (frameworks mount in the deferred post
      // hook) — the dev analogue of the deployed entry dispatching effect
      // routes before the framework handler.
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
          );
          // Raw pathname, matching the deployed wrapper's dispatch.
          // Strict route ownership: only paths outside `server.routes`
          // fall through to the framework.
          if (!matchServerRoutes(routes, url.pathname)) {
            next();
            return;
          }
          // Through the module runner so site-module edits hot-invalidate.
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
            const env: Record<string, unknown> = {
              ...process.env,
              // The markers the deployed runtime gets from its host — the
              // bridge's four-worlds guard and Stack layer key off them.
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
