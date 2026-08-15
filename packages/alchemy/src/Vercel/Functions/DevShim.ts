/**
 * The Vercel local dev shim — a Node HTTP server that emulates Vercel's
 * Node launcher for `alchemy dev`.
 *
 * The `LocalFunctionProvider` bundles this module INTO the dev bundle (a
 * generated virtual entry imports the user's module — or the generated
 * Effect bridge — and calls {@link startVercelFunctionDevServer}), then
 * runs the emitted bundle as a child process. One child per Function keeps
 * `process.env` faithful to the deployed instance (each Vercel Function
 * runs in its own process with its own env).
 *
 * **Launcher matrix** (dev/prod skew here is a bug factory — this shim
 * implements the FULL matrix Vercel's Node launcher accepts):
 *
 * 1. `export default { fetch }` — web-standard handler object.
 * 2. `export default function` — web `(request: Request) => Response` when
 *    the function declares 0–1 parameters, Node `(req, res)` style when it
 *    declares 2+.
 * 3. Method exports (`export function GET/POST/...`) — routed by request
 *    method; a missing `HEAD` falls back to `GET` (the launcher strips the
 *    body); an unexported method is a 405 with an `Allow` header.
 *
 * Also emulated:
 *
 * - **`waitUntil`** — the `Symbol.for("@vercel/request-context")` contract
 *   `@vercel/functions` wraps: handed promises are tracked and drained on
 *   SIGTERM before exit (mirroring Fluid's shutdown grace window).
 * - **Platform request headers** — `x-vercel-id`, deployment URL, geo and
 *   forwarding headers are injected when absent so header-reading code
 *   behaves like it does deployed.
 * - **Queue seam** — when the generated entry passes `queueFetch` (the
 *   queue-mode Effect bridge), requests to {@link QUEUE_DELIVERY_PATH} are
 *   dispatched to it. This is the local queue broker's delivery endpoint
 *   (see `LocalFunctionInstance.queueEndpoint` in `Vercel/LocalRuntime.ts`).
 *
 * This module MUST stay free of `effect`/alchemy imports: it is bundled
 * into async-mode functions that deliberately ship no Effect runtime.
 */
import * as http from "node:http";
import { Readable, type Duplex } from "node:stream";

/** Marker line printed to stdout once the server is listening. */
export const DEV_READY_PREFIX = "__ALCHEMY_VERCEL_DEV_READY__[";
export const DEV_READY_SUFFIX = "]__";

/**
 * The dev-only route queue deliveries are POSTed to (proxied through the
 * function's stable local URL). Only served when the entry passed a
 * `queueFetch` dispatch.
 */
export const QUEUE_DELIVERY_PATH = "/_alchemy/dev/queue";

/** Env var carrying the port the shim should listen on (`0` = ephemeral). */
export const DEV_PORT_ENV = "ALCHEMY_DEV_PORT";

export interface VercelDevShimOptions {
  /**
   * The Function's module namespace (async mode) or `{ default: bridge }`
   * (Effect mode, where `bridge` is the `makeVercelBridge` result).
   */
  readonly module: Record<string, unknown>;
  /**
   * The queue-mode bridge's `fetch`, when the Function registered queue
   * subscriptions. Dispatches {@link QUEUE_DELIVERY_PATH} requests.
   */
  readonly queueFetch?: (request: Request) => Promise<Response>;
}

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const METHOD_EXPORTS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

const toWebRequest = (req: http.IncomingMessage): Request => {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: METHODS_WITH_BODY.has(method)
      ? (Readable.toWeb(req) as unknown as BodyInit)
      : undefined,
    // Node requires half-duplex for streamed request bodies.
    ...({ duplex: "half" } as object),
  });
};

const writeWebResponse = async (
  res: http.ServerResponse,
  response: Response,
  options?: { readonly stripBody?: boolean },
): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) res.setHeader("set-cookie", setCookie);
  if (response.body === null || options?.stripBody) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    body.once("error", reject);
    res.once("close", resolve);
    res.once("error", reject);
    body.pipe(res as unknown as Duplex, { end: true });
  });
};

/**
 * Inject the platform headers Vercel puts on every request, when absent —
 * so header-reading user code (request ids, geo, forwarding info) behaves
 * like it does deployed.
 */
const injectPlatformHeaders = (req: http.IncomingMessage): void => {
  const setDefault = (key: string, value: string | undefined) => {
    if (value !== undefined && req.headers[key] === undefined) {
      req.headers[key] = value;
    }
  };
  setDefault(
    "x-vercel-id",
    `dev1::dev1::${Math.random().toString(36).slice(2, 12)}`,
  );
  setDefault("x-vercel-deployment-url", process.env.VERCEL_URL);
  setDefault("x-real-ip", "127.0.0.1");
  setDefault("x-forwarded-for", "127.0.0.1");
  setDefault("x-forwarded-host", req.headers.host);
  setDefault("x-forwarded-proto", "http");
  setDefault("x-vercel-ip-country", "US");
  setDefault("x-vercel-ip-country-region", "CA");
  setDefault("x-vercel-ip-city", "Localhost");
  setDefault("x-vercel-ip-latitude", "37.7749");
  setDefault("x-vercel-ip-longitude", "-122.4194");
  setDefault("x-vercel-ip-timezone", "America/Los_Angeles");
};

type WebHandler = (request: Request) => Response | Promise<Response>;
type NodeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => unknown;

type Dispatch = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

/** Resolve the module's export shape to a single dispatch function. */
const resolveDispatch = (mod: Record<string, unknown>): Dispatch => {
  const dflt = mod.default;
  const webDispatch =
    (handler: WebHandler, stripBody = false): Dispatch =>
    async (req, res) => {
      const response = await handler(toWebRequest(req));
      await writeWebResponse(res, response, {
        stripBody: stripBody || req.method === "HEAD",
      });
    };
  if (
    typeof dflt === "object" &&
    dflt !== null &&
    typeof (dflt as { fetch?: unknown }).fetch === "function"
  ) {
    const fetchHandler = (dflt as { fetch: WebHandler }).fetch.bind(dflt);
    return webDispatch(fetchHandler);
  }
  if (typeof dflt === "function") {
    // Arity heuristic (matching the launcher): a `(req, res)` Node handler
    // declares two parameters; a web handler declares at most one.
    if (dflt.length >= 2) {
      const nodeHandler = dflt as NodeHandler;
      return async (req, res) => {
        await nodeHandler(req, res);
      };
    }
    return webDispatch(dflt as WebHandler);
  }
  // Method exports.
  const methodHandlers = new Map<string, WebHandler>();
  for (const method of METHOD_EXPORTS) {
    const handler = mod[method];
    if (typeof handler === "function") {
      methodHandlers.set(method, handler as WebHandler);
    }
  }
  if (methodHandlers.size > 0) {
    return async (req, res) => {
      const method = req.method ?? "GET";
      const handler =
        methodHandlers.get(method) ??
        // The launcher serves HEAD with the GET handler, body stripped.
        (method === "HEAD" ? methodHandlers.get("GET") : undefined);
      if (handler === undefined) {
        res.statusCode = 405;
        res.setHeader("allow", Array.from(methodHandlers.keys()).join(", "));
        res.end("Method Not Allowed");
        return;
      }
      await webDispatch(handler, method === "HEAD")(req, res);
    };
  }
  return async (_req, res) => {
    res.statusCode = 500;
    res.end(
      "No handler export found — export default { fetch }, a default function, or method exports (GET/POST/...)",
    );
  };
};

/**
 * Start the dev server for the given module. Called by the generated dev
 * bundle entry; never imported by deployed code.
 */
export const startVercelFunctionDevServer = (
  options: VercelDevShimOptions,
): void => {
  // ── waitUntil shim: the `@vercel/request-context` contract.
  const pending = new Set<Promise<unknown>>();
  const waitUntil = (promise: Promise<unknown>): void => {
    const tracked = Promise.resolve(promise)
      .catch(() => {})
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  (globalThis as Record<symbol, unknown> & typeof globalThis)[
    Symbol.for("@vercel/request-context")
  ] = { get: () => ({ waitUntil }) };

  const dispatch = resolveDispatch(options.module);
  const queueFetch = options.queueFetch;

  const server = http.createServer((req, res) => {
    injectPlatformHeaders(req);
    const pathname = (req.url ?? "/").split("?")[0];
    const run =
      queueFetch !== undefined && pathname === QUEUE_DELIVERY_PATH
        ? toWebRequest(req)
        : undefined;
    void (
      run !== undefined
        ? queueFetch!(run).then((response) => writeWebResponse(res, response))
        : dispatch(req, res)
    ).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[alchemy dev] request failed", error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });

  const port = Number(process.env[DEV_PORT_ENV] ?? "0");
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort =
      typeof address === "object" && address !== null ? address.port : port;
    // The readiness marker the provider watches stdout for.
    // eslint-disable-next-line no-console
    console.log(
      `${DEV_READY_PREFIX}http://127.0.0.1:${boundPort}${DEV_READY_SUFFIX}`,
    );
  });

  // Graceful shutdown: stop accepting, drain waitUntil promises (bounded —
  // Fluid's real window is ~500ms; locally we allow a little more), exit.
  process.once("SIGTERM", () => {
    server.close();
    const drain = Promise.all(Array.from(pending));
    void Promise.race([
      drain,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]).finally(() => process.exit(0));
  });
};
