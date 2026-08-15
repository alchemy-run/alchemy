/**
 * Shared state for the dev-mode (`alchemy dev`) Vercel Edge Config
 * emulation: an in-memory registry of local Edge Configs (+ their read
 * tokens) and a lazily started local HTTP endpoint speaking the EXACT
 * data-plane read protocol probed against `@vercel/edge-config@1.5.1`
 * (PROBES.md §10):
 *
 * - `GET {base}/item/{key}?version=1` → the item's JSON value
 * - `GET {base}/items?version=1[&key=…]` → record of (a subset of) items
 * - `HEAD {base}/item/{key}?version=1` → 200 / 404
 * - `GET {base}/digest?version=1` → the content digest (a JSON string)
 * - bearer auth (`Authorization: Bearer <token>`)
 * - a missing ITEM is a 404 **with** an `x-edge-config-digest` header; a
 *   bare 404 means "config not found" (the SDK throws on it), and an
 *   invalid token is a 401.
 *
 * The registry lives in the dev sidecar (see `Vercel/Local.ts`) — or the
 * test process under `sidecar: false` — shared by the `EdgeConfig` and
 * `EdgeConfigToken` local providers via {@link localVercelServices}. The
 * server starts on first demand (an ephemeral port) and is torn down with
 * the state layer's scope; connection strings minted by the local token
 * provider point at it, so both alchemy's read clients and the real
 * `@vercel/edge-config` SDK (which follows arbitrary hosts, probe-verified)
 * round-trip against it unchanged.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { httpServer } from "../../Util/PlatformServices.ts";
import { sha256 } from "../../Util/sha256.ts";
import { stableStringify } from "../../Util/stable.ts";

/** The `dev:` marker prefix for locally emulated Edge Config ids. */
export const LOCAL_EDGE_CONFIG_ID_PREFIX = "dev:ecfg_";

/** The `dev:` marker prefix for locally minted Edge Config read tokens. */
export const LOCAL_EDGE_CONFIG_TOKEN_PREFIX = "dev:ectok_";

/** `true` for a locally emulated (`dev:`-marked) Edge Config id. */
export const isLocalEdgeConfigId = (id: string | undefined): id is string =>
  typeof id === "string" && id.startsWith("dev:");

/** A locally emulated Edge Config: the registry row the server reads. */
export interface LocalEdgeConfigEntry {
  readonly edgeConfigId: string;
  readonly slug: string;
  readonly items: Record<string, unknown>;
  /** Content digest — sha256 over the canonical item serialization. */
  readonly digest: string;
  readonly createdAt: number;
  readonly itemCount: number;
  readonly sizeInBytes: number;
}

/** The local content digest — changes exactly when the items change. */
export const computeLocalDigest = (
  items: Record<string, unknown>,
): Effect.Effect<string> => sha256(stableStringify(items));

/**
 * Registry of locally emulated Edge Configs and read tokens, plus the
 * lazily started local data-plane server. Lives in the dev sidecar (or the
 * test process when `sidecar: false`), shared by the EdgeConfig and
 * EdgeConfigToken local providers built from {@link localVercelServices}.
 */
export class LocalEdgeConfigState extends Context.Service<
  LocalEdgeConfigState,
  {
    /** Local configs, keyed by `dev:ecfg_…` id. */
    readonly configs: MutableHashMap.MutableHashMap<
      string,
      LocalEdgeConfigEntry
    >;
    /** Valid read tokens: token value → the `dev:ecfg_…` id it reads. */
    readonly tokens: MutableHashMap.MutableHashMap<string, string>;
    /**
     * The local data-plane origin (`http://localhost:<port>`, no trailing
     * slash). Starts the server on first demand; memoized for the state's
     * lifetime.
     */
    readonly serverUrl: Effect.Effect<string>;
  }
>()("alchemy/vercel/LocalEdgeConfigState") {}

/**
 * Handle one data-plane read against the registry (see the module doc for
 * the protocol contract).
 */
const handleRead = (
  request: HttpServerRequest.HttpServerRequest,
  configs: MutableHashMap.MutableHashMap<string, LocalEdgeConfigEntry>,
  tokens: MutableHashMap.MutableHashMap<string, string>,
): HttpServerResponse.HttpServerResponse => {
  const url = new URL(request.url, "http://localhost");
  const segments = url.pathname.split("/").filter((s) => s !== "");
  const edgeConfigId = decodeURIComponent(segments[0] ?? "");
  const entry = Option.getOrUndefined(
    MutableHashMap.get(configs, edgeConfigId),
  );
  if (entry === undefined) {
    // Bare 404 (no digest header) — the SDK's "config not found" signal.
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
  const token = bearer ?? url.searchParams.get("token") ?? undefined;
  const authorized =
    token !== undefined &&
    Option.getOrUndefined(MutableHashMap.get(tokens, token)) === edgeConfigId;
  if (!authorized) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }
  const headers = { "x-edge-config-digest": entry.digest };
  const route = segments[1];
  if (route === "digest" && segments.length === 2) {
    // The digest endpoint answers a JSON *string*.
    return HttpServerResponse.jsonUnsafe(entry.digest, { headers });
  }
  if (route === "items" && segments.length === 2) {
    const keys = url.searchParams.getAll("key");
    const items =
      keys.length === 0
        ? entry.items
        : Object.fromEntries(
            keys
              .filter((key) => Object.hasOwn(entry.items, key))
              .map((key) => [key, entry.items[key]]),
          );
    return HttpServerResponse.jsonUnsafe(items, { headers });
  }
  if (route === "item" && segments.length >= 3) {
    const key = decodeURIComponent(segments.slice(2).join("/"));
    const exists = Object.hasOwn(entry.items, key);
    if (request.method === "HEAD") {
      return HttpServerResponse.empty({ status: exists ? 200 : 404, headers });
    }
    if (!exists) {
      // Missing ITEM: 404 *with* the digest header — the SDK (and our
      // clients) decode this as `undefined`, never as an error.
      return HttpServerResponse.text("Not Found", { status: 404, headers });
    }
    return HttpServerResponse.jsonUnsafe(entry.items[key], { headers });
  }
  return HttpServerResponse.text("Not Found", { status: 404 });
};

/** Serve the local data-plane endpoint in the ambient `Scope`. */
const serveLocalEdgeConfig = Effect.fn(function* (
  configs: MutableHashMap.MutableHashMap<string, LocalEdgeConfigEntry>,
  tokens: MutableHashMap.MutableHashMap<string, string>,
) {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return handleRead(request, configs, tokens);
  });
  const context = yield* Layer.build(
    httpServer(0, "127.0.0.1"),
  ) as Effect.Effect<
    Context.Context<HttpServer.HttpServer>,
    unknown,
    Scope.Scope
  >;
  const server = Context.get(context, HttpServer.HttpServer);
  yield* server.serve(handler);
  return HttpServer.formatAddress(server.address)
    .replace("127.0.0.1", "localhost")
    .replace(/\/$/, "");
});

/**
 * The {@link LocalEdgeConfigState} layer — a module-level constant so every
 * composition site shares one layer identity (the stack build's `MemoMap`
 * then dedupes it to a single registry + server per build; see
 * `localVercelServices`).
 */
export const LocalEdgeConfigStateLive = Layer.effect(
  LocalEdgeConfigState,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const configs = MutableHashMap.empty<string, LocalEdgeConfigEntry>();
    const tokens = MutableHashMap.empty<string, string>();
    const serverUrl = yield* Effect.cached(
      // The server lives for the whole state lifetime (torn down with the
      // layer scope), not for the lifetime of the demanding call.
      serveLocalEdgeConfig(configs, tokens).pipe(
        Scope.provide(scope),
        Effect.orDie,
      ),
    );
    return LocalEdgeConfigState.of({ configs, tokens, serverUrl });
  }),
);
