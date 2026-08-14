/**
 * The effect front dispatch of the Next.js custom-server dev topology —
 * shared by the AWS dev child (`aws-dev-entry.ts`, plain node) and the
 * Cloudflare `hmr` dev server (`DevServer.ts`, in the vite dev child).
 *
 * One listener, no proxy: the dev http server offers each request to the
 * effect program FIRST (`Serve.make(Site).match` — rpc-first + strict
 * route ownership, byte-for-byte the deployed wrapper's gate) and falls
 * through to Next's `getRequestHandler()` on a decline. This erases the
 * explicit `toRouteHandler` mount from both clouds' `next dev` stories.
 *
 * Module-identity contract: the serve surface is imported from
 * {@link EffectDispatchConfig.serveModule} — a path the ALCHEMY ENGINE
 * resolved from its own module graph (`import.meta.resolve`) — so the
 * bridge, the backend module's own bare `alchemy/*` imports, and every
 * `WeakMap`/global the runtime keys on come from ONE alchemy instance.
 * This package deliberately does not import alchemy.
 *
 * Effect-handler hot reload (AWS child only, `watch: true`): the backend
 * module's directory is watched; an edit triggers a cache-busted dynamic
 * re-import (`?alchemy-dev=N` — node keys its ESM cache on the full URL
 * including the query; bun does not, which is one of the reasons the AWS
 * dev child is always plain node). The fresh class identity makes the
 * serve runtime lazily build a fresh layer stack on the next matched
 * request; the retired generation is disposed (`serve.dispose`) once its
 * in-flight requests settle, so repeated edits never accumulate layer
 * scopes or SIGTERM listeners. Only alchemy/effect must stay OUT of the
 * cache-busted graph — the backend re-import resolves them to the same
 * cached module instances (no query), keeping tag and memo identity
 * stable across generations.
 *
 * Dependency-light by design: node builtins only — this module is
 * bundled into the plain-node dev child entry.
 */
import type * as NodeHttp from "node:http";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The structural slice of `alchemy/Serve` (`Serve/Serve.ts`) we drive. */
interface ServeModule {
  readonly make: (
    site: object,
    options?: { readonly routes?: readonly string[] },
  ) => {
    readonly match: (request: Request) => Promise<Response | undefined>;
  };
  readonly dispose?: (site: object) => Promise<void>;
  readonly isRpcPath: (pathname: string) => boolean;
  readonly matchRoutes: (
    routes: readonly string[],
    pathname: string,
  ) => boolean;
  readonly DEFAULT_SERVER_ROUTES: readonly string[];
}

/** Plain-JSON dispatch config (crosses the dev-child argv boundary). */
export interface EffectDispatchConfig {
  /**
   * The user's backend module (`props.main` — an absolute path or
   * `file://` URL) default-exporting the Website class.
   */
  readonly main: string;
  /**
   * Path globs the effect fetch owns (`server.routes`). The universal
   * `/api/__rpc` path is always dispatched regardless.
   * @default the serve module's DEFAULT_SERVER_ROUTES (["/api/*"])
   */
  readonly routes?: readonly string[] | undefined;
  /**
   * Absolute path or `file://` URL of the `alchemy/Serve` surface module
   * (`Serve/Serve.ts` re-exports), resolved BY THE ENGINE from its own
   * alchemy — see the module doc's identity contract.
   */
  readonly serveModule: string;
  /**
   * Watch the backend module's directory and hot-swap the serve handle on
   * edits (cache-busted re-import). AWS dev child only — requires plain
   * node (bun ignores import query strings).
   * @default false
   */
  readonly watch?: boolean | undefined;
}

export interface EffectDispatchHandle {
  /**
   * Offer the request to the effect program. Resolves `true` when the
   * response was written to `res` (rpc dispatch, or a path inside the
   * routes claim); `false` when the framework should serve it — in that
   * case `req`/`res` are untouched.
   */
  readonly dispatch: (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
  ) => Promise<boolean>;
  /** Stop the watcher and dispose the current generation's runtime. */
  readonly close: () => Promise<void>;
}

const toFileUrl = (pathOrUrl: string): string =>
  pathOrUrl.startsWith("file:")
    ? pathOrUrl
    : pathToFileURL(NodePath.resolve(pathOrUrl)).href;

/**
 * Node `IncomingMessage` → fetch `Request`. The body is only attached for
 * body-carrying methods and streams lazily (`Readable.toWeb`); callers
 * must NOT construct one for requests that may fall through to the
 * framework — attaching listeners to the node stream would corrupt the
 * framework's own read. The dispatch below therefore pre-gates on the
 * pathname before ever building the Request.
 */
export const toWebRequest = (req: NodeHttp.IncomingMessage): Request => {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as RequestInit["body"];
    init.duplex = "half";
  }
  return new Request(url, init);
};

/**
 * Write a fetch `Response` to a node `ServerResponse`, preserving
 * streaming bodies (chunk-by-chunk with backpressure) and multi-value
 * `set-cookie` headers.
 */
export const writeWebResponse = async (
  res: NodeHttp.ServerResponse,
  response: Response,
): Promise<void> => {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => res.once("drain", () => resolve()));
    }
  }
  res.end();
};

/** One loaded backend generation: the class, its serve handle, and the
 * drain bookkeeping that defers disposal past in-flight requests. */
interface Generation {
  readonly site: object;
  readonly handle: {
    readonly match: (request: Request) => Promise<Response | undefined>;
  };
  pending: number;
  retired: boolean;
}

/**
 * Build the front dispatch for a backend module. Fails when the backend
 * module (or the serve module) cannot be imported — a broken backend is a
 * loud dev-server startup failure, exactly like a broken deploy.
 */
export const createEffectDispatch = async (
  config: EffectDispatchConfig,
): Promise<EffectDispatchHandle> => {
  const serve = (await import(
    toFileUrl(config.serveModule)
  )) as unknown as ServeModule;
  const routes = config.routes ?? serve.DEFAULT_SERVER_ROUTES;
  const mainUrl = toFileUrl(config.main);

  let generation = 0;
  const load = async (): Promise<Generation> => {
    generation += 1;
    // Cache-busted after the first load: node keys its ESM cache on the
    // full URL including the query, so `?alchemy-dev=N` yields a fresh
    // class identity while the backend's own (query-less) alchemy/effect
    // imports stay cached — one alchemy instance across generations.
    const url =
      generation === 1 ? mainUrl : `${mainUrl}?alchemy-dev=${generation}`;
    const module_ = (await import(url)) as { default?: object };
    const site = module_.default;
    if (site === undefined || site === null) {
      throw new Error(
        `The backend module has no default export (expected the Website class): ${config.main}`,
      );
    }
    return {
      site,
      handle: serve.make(site, { routes }),
      pending: 0,
      retired: false,
    };
  };

  const disposeGeneration = (old: Generation): void => {
    old.retired = true;
    if (old.pending === 0 && serve.dispose !== undefined) {
      void serve.dispose(old.site).catch(() => {});
    }
  };

  let current = await load();

  // ── watch → debounced cache-busted re-import → atomic handle swap ──
  let watcher: NodeFs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let reloading: Promise<void> = Promise.resolve();
  if (config.watch === true) {
    const watchDir = NodePath.dirname(fileURLToPath(mainUrl));
    const reload = async (): Promise<void> => {
      try {
        const next = await load();
        const previous = current;
        current = next; // single assignment — atomic wrt per-request reads
        disposeGeneration(previous);
        console.error(
          `[alchemy] effect backend reloaded (${NodePath.basename(watchDir)}, generation ${generation})`,
        );
      } catch (error) {
        console.error(
          "[alchemy] effect backend reload failed (the previous handlers keep serving):",
          error,
        );
      }
    };
    watcher = NodeFs.watch(watchDir, { recursive: true }, () => {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => {
        // Serialize reloads so generations can never interleave.
        reloading = reloading.then(reload);
      }, 200);
    });
  }

  const dispatch = async (
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
  ): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Cheap pre-gate BEFORE constructing a body-carrying Request: outside
    // the claim (and off the rpc path) the framework serves — its Next
    // server actions, route handlers, and pages must receive a pristine
    // node stream.
    if (!serve.isRpcPath(pathname) && !serve.matchRoutes(routes, pathname)) {
      return false;
    }
    const active = current;
    active.pending += 1;
    try {
      const matched = await active.handle.match(toWebRequest(req));
      if (matched === undefined) {
        return false;
      }
      await writeWebResponse(res, matched);
      return true;
    } finally {
      active.pending -= 1;
      if (active.retired && active.pending === 0) {
        disposeGeneration(active);
      }
    }
  };

  return {
    dispatch,
    close: async () => {
      watcher?.close();
      if (debounce !== undefined) clearTimeout(debounce);
      await reloading.catch(() => {});
      const last = current;
      if (serve.dispose !== undefined) {
        await serve.dispose(last.site).catch(() => {});
      }
    },
  };
};
