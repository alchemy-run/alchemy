import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Binding from "../../Binding.ts";
import { unpackEnvValue, type RuntimeContext } from "../../RuntimeContext.ts";
import type { EdgeConfig } from "./EdgeConfig.ts";

/**
 * A data-plane read against the Edge Config failed. Reads go to
 * `https://edge-config.vercel.com/{edgeConfigId}` with bearer auth; the
 * protocol contract (probe-verified against `@vercel/edge-config@1.5.1`):
 * a missing ITEM is a 404 *with* an `x-edge-config-digest` header, while a
 * bare 404 means the config itself (or the token) is invalid.
 */
export class EdgeConfigReadError extends Data.TaggedError(
  "Vercel.EdgeConfigReadError",
)<{
  readonly message: string;
  /** The operation that failed (`get` | `getAll` | `has` | `digest`). */
  readonly operation: string;
  /** HTTP status of the failing response, when one was received. */
  readonly status?: number | undefined;
  readonly cause?: unknown;
}> {}

/**
 * Typed read client for an {@link EdgeConfig} — the same surface as
 * `@vercel/edge-config` (`get`/`getAll`/`has`/`digest`), returned by the
 * {@link EdgeConfigRead} binding. Every method requires
 * {@link RuntimeContext}: reads resolve the connection string minted for
 * the deployed Function.
 */
export interface ReadEdgeConfigClient {
  /** Read a single item; `undefined` when the key does not exist. */
  get<T = unknown>(
    key: string,
  ): Effect.Effect<T | undefined, EdgeConfigReadError, RuntimeContext>;
  /** Read all items (or the given subset of keys) as a record. */
  getAll<T extends Record<string, unknown> = Record<string, unknown>>(
    keys?: readonly string[],
  ): Effect.Effect<T, EdgeConfigReadError, RuntimeContext>;
  /** `true` when the key exists. */
  has(key: string): Effect.Effect<boolean, EdgeConfigReadError, RuntimeContext>;
  /** The config's content digest — changes whenever any item changes. */
  digest(): Effect.Effect<string, EdgeConfigReadError, RuntimeContext>;
}

/**
 * Bind an {@link EdgeConfig} to a Function with read access and obtain the
 * typed data-plane client (`get`, `getAll`, `has`, `digest`).
 *
 * The implementation layer ({@link ReadEdgeConfigHttp}) mints a scoped
 * {@link EdgeConfigToken} per Function (observe-and-keep — never rotated
 * while it exists) and injects the connection string as a `sensitive`
 * project env var; the runtime client follows that connection string
 * against `https://edge-config.vercel.com`.
 *
 * @binding
 * @section Reading an Edge Config
 * @example Feature flags inside an Effect-native Function
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const flags = yield* Vercel.EdgeConfig("Flags", {
 *       items: { enableCheckout: true },
 *     });
 *     const config = yield* Vercel.ReadEdgeConfig(flags);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const enabled = yield* config
 *           .get<boolean>("enableCheckout")
 *           .pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({ enabled });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.ReadEdgeConfigHttp)),
 * ) {}
 * ```
 *
 * @example Reading multiple items and the digest
 * ```typescript
 * const all = yield* config.getAll().pipe(Effect.orDie);
 * const some = yield* config.getAll(["a", "b"]).pipe(Effect.orDie);
 * const exists = yield* config.has("a").pipe(Effect.orDie);
 * const digest = yield* config.digest().pipe(Effect.orDie);
 * ```
 */
export interface EdgeConfigRead extends Binding.Service<
  EdgeConfigRead,
  "Vercel.EdgeConfigRead",
  (config: EdgeConfig) => Effect.Effect<ReadEdgeConfigClient>
> {}

export const EdgeConfigRead = Binding.Service<EdgeConfigRead>(
  "Vercel.EdgeConfigRead",
);

/**
 * Ergonomic alias for {@link EdgeConfigRead} —
 * `yield* Vercel.ReadEdgeConfig(flags)`.
 */
export const ReadEdgeConfig = EdgeConfigRead;

// ─────────────────────────────────────────────────────────────────────────────
// Connection strings
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgeConfigConnection {
  /** Data-plane base URL (`https://edge-config.vercel.com/{edgeConfigId}`). */
  readonly baseUrl: string;
  /** The read token (the `token` query parameter). */
  readonly token: string;
}

/**
 * Parse an Edge Config connection string
 * (`https://edge-config.vercel.com/{edgeConfigId}?token={token}`) into its
 * base URL + token. Throws a plain `Error` on malformed input (callers in
 * Effect code wrap it in `Effect.try`).
 */
export const parseEdgeConfigConnectionString = (
  connectionString: string,
): EdgeConfigConnection => {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "Invalid Edge Config connection string: expected https://edge-config.vercel.com/{edgeConfigId}?token={token}",
    );
  }
  const token = url.searchParams.get("token");
  if (token === null || token === "" || url.pathname.length <= 1) {
    throw new Error(
      "Invalid Edge Config connection string: expected https://edge-config.vercel.com/{edgeConfigId}?token={token}",
    );
  }
  return { baseUrl: `${url.origin}${url.pathname}`, token };
};

// ─────────────────────────────────────────────────────────────────────────────
// Effect client
// ─────────────────────────────────────────────────────────────────────────────

/** The missing-item 404 marker (see {@link EdgeConfigReadError}). */
const isMissingItem404 = (
  response: HttpClientResponse.HttpClientResponse,
): boolean =>
  response.status === 404 &&
  response.headers["x-edge-config-digest"] !== undefined;

const readFailure = (
  operation: string,
  status: number | undefined,
  message: string,
  cause?: unknown,
): EdgeConfigReadError =>
  new EdgeConfigReadError({ message, operation, status, cause });

/**
 * Build a {@link ReadEdgeConfigClient} from a connection string (a plain
 * value or an accessor Effect — the {@link ReadEdgeConfigHttp} binding
 * passes the env-injected accessor). The `HttpClient` is captured once at
 * construction.
 */
export const makeReadEdgeConfigClient = (
  connection:
    | string
    | Redacted.Redacted<string>
    | Effect.Effect<string | Redacted.Redacted<string> | undefined>,
): Effect.Effect<ReadEdgeConfigClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();

    const resolveConnection = Effect.gen(function* () {
      const raw = Effect.isEffect(connection) ? yield* connection : connection;
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      if (value === undefined || value === "") {
        return yield* readFailure(
          "connect",
          undefined,
          "Edge Config connection string is not available — was the EdgeConfigRead binding deployed with this Function?",
        );
      }
      return yield* Effect.try({
        try: () => parseEdgeConfigConnectionString(value),
        catch: (cause) =>
          readFailure(
            "connect",
            undefined,
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
      });
    });

    const execute = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      token: string,
    ) =>
      HttpClient.HttpClient.pipe(
        Effect.flatMap((client) =>
          client.execute(HttpClientRequest.bearerToken(request, token)),
        ),
        Effect.mapError((cause) =>
          readFailure(
            operation,
            undefined,
            `Edge Config ${operation} request failed: ${String(cause)}`,
            cause,
          ),
        ),
        Effect.provideContext(context),
      );

    const failStatus = (
      operation: string,
      response: HttpClientResponse.HttpClientResponse,
    ) =>
      response.text.pipe(
        Effect.mapError((cause) =>
          readFailure(operation, response.status, String(cause), cause),
        ),
        Effect.flatMap((body) =>
          readFailure(
            operation,
            response.status,
            body !== "" ? body : `HTTP ${response.status}`,
          ),
        ),
      );

    const readJson = <T>(
      operation: string,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<T, EdgeConfigReadError> =>
      response.json.pipe(
        Effect.mapError((cause) =>
          readFailure(
            operation,
            response.status,
            `Edge Config ${operation}: invalid JSON response`,
            cause,
          ),
        ),
        Effect.map((value) => value as T),
      );

    const get = <T = unknown>(
      key: string,
    ): Effect.Effect<T | undefined, EdgeConfigReadError> =>
      Effect.gen(function* () {
        const { baseUrl, token } = yield* resolveConnection;
        const response = yield* execute(
          "get",
          HttpClientRequest.get(
            `${baseUrl}/item/${encodeURIComponent(key)}`,
          ).pipe(HttpClientRequest.appendUrlParam("version", "1")),
          token,
        );
        if (isMissingItem404(response)) {
          yield* Effect.ignore(response.text);
          return undefined;
        }
        if (response.status !== 200) {
          return yield* failStatus("get", response);
        }
        return yield* readJson<T>("get", response);
      });

    const getAll = <
      T extends Record<string, unknown> = Record<string, unknown>,
    >(
      keys?: readonly string[],
    ): Effect.Effect<T, EdgeConfigReadError> =>
      Effect.gen(function* () {
        const { baseUrl, token } = yield* resolveConnection;
        let request = HttpClientRequest.get(`${baseUrl}/items`).pipe(
          HttpClientRequest.appendUrlParam("version", "1"),
        );
        for (const key of keys ?? []) {
          request = HttpClientRequest.appendUrlParam(request, "key", key);
        }
        const response = yield* execute("getAll", request, token);
        if (response.status !== 200) {
          return yield* failStatus("getAll", response);
        }
        return yield* readJson<T>("getAll", response);
      });

    const has = (key: string): Effect.Effect<boolean, EdgeConfigReadError> =>
      Effect.gen(function* () {
        const { baseUrl, token } = yield* resolveConnection;
        const response = yield* execute(
          "has",
          HttpClientRequest.head(
            `${baseUrl}/item/${encodeURIComponent(key)}`,
          ).pipe(HttpClientRequest.appendUrlParam("version", "1")),
          token,
        );
        yield* Effect.ignore(response.text);
        if (response.status === 200) return true;
        if (isMissingItem404(response)) return false;
        return yield* failStatus("has", response);
      });

    const digest = (): Effect.Effect<string, EdgeConfigReadError> =>
      Effect.gen(function* () {
        const { baseUrl, token } = yield* resolveConnection;
        const response = yield* execute(
          "digest",
          HttpClientRequest.get(`${baseUrl}/digest`).pipe(
            HttpClientRequest.appendUrlParam("version", "1"),
          ),
          token,
        );
        if (response.status !== 200) {
          return yield* failStatus("digest", response);
        }
        return yield* readJson<string>("digest", response);
      });

    return { get, getAll, has, digest } satisfies ReadEdgeConfigClient;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Async mode (no Effect runtime)
// ─────────────────────────────────────────────────────────────────────────────

/** Promise-based Edge Config read client for plain async Functions. */
export interface AsyncReadEdgeConfigClient {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getAll<T extends Record<string, unknown> = Record<string, unknown>>(
    keys?: readonly string[],
  ): Promise<T>;
  has(key: string): Promise<boolean>;
  digest(): Promise<string>;
}

/**
 * `fromEnv`-style constructor for **plain async Functions** (no Effect
 * runtime shipped): resolves the connection string from the given env var
 * at call time (handling both raw connection strings and alchemy's
 * marker-packed sensitive values) and reads via plain `fetch`, throwing
 * plain `Error`s. For Effect code use {@link ReadEdgeConfig} (bound) or
 * {@link makeReadEdgeConfigClient}.
 *
 * @example Async handler
 * ```typescript
 * import { readEdgeConfigFromEnv } from "alchemy/Vercel";
 * const flags = readEdgeConfigFromEnv("FLAGS");
 *
 * export default {
 *   async fetch(): Promise<Response> {
 *     return Response.json({
 *       checkout: await flags.get("enableCheckout"),
 *     });
 *   },
 * };
 * ```
 */
export const readEdgeConfigFromEnv = (
  envKey = "EDGE_CONFIG",
): AsyncReadEdgeConfigClient => {
  const connect = (): EdgeConfigConnection => {
    const unpacked = unpackEnvValue<unknown>(process.env[envKey]);
    const value = Redacted.isRedacted(unpacked)
      ? (Redacted.value(unpacked) as string)
      : unpacked;
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `readEdgeConfigFromEnv(${envKey}): env var is not set — bind an EdgeConfigToken connection string to it`,
      );
    }
    return parseEdgeConfigConnectionString(value);
  };
  const request = async (
    operation: string,
    path: string,
    keys?: readonly string[],
    method: "GET" | "HEAD" = "GET",
  ): Promise<Response> => {
    const { baseUrl, token } = connect();
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("version", "1");
    for (const key of keys ?? []) {
      url.searchParams.append("key", key);
    }
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (
      response.status !== 200 &&
      !(
        response.status === 404 &&
        response.headers.get("x-edge-config-digest") !== null
      )
    ) {
      const body = await response.text();
      throw new Error(
        `readEdgeConfigFromEnv(${envKey}).${operation}: HTTP ${response.status}${body !== "" ? `: ${body}` : ""}`,
      );
    }
    return response;
  };
  return {
    async get(key) {
      const response = await request("get", `/item/${encodeURIComponent(key)}`);
      if (response.status === 404) {
        await response.text();
        return undefined;
      }
      return (await response.json()) as never;
    },
    async getAll(keys) {
      const response = await request("getAll", "/items", keys);
      return (await response.json()) as never;
    },
    async has(key) {
      const response = await request(
        "has",
        `/item/${encodeURIComponent(key)}`,
        undefined,
        "HEAD",
      );
      return response.status === 200;
    },
    async digest() {
      const response = await request("digest", "/digest");
      return (await response.json()) as string;
    },
  };
};
