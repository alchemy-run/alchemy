import * as EdgeConfigData from "@distilled.cloud/vercel/edge_config_data";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import { unpackEnvValue, type RuntimeContext } from "../../RuntimeContext.ts";
import type { EdgeConfig } from "./EdgeConfig.ts";

/**
 * A data-plane read against the Edge Config failed. Reads go to
 * `https://edge-config.vercel.com/{edgeConfigId}` with bearer auth via the
 * distilled `edge_config_data` service; the protocol contract
 * (probe-verified against `@vercel/edge-config@1.5.1`): a missing ITEM is a
 * 404 *with* an `x-edge-config-digest` header (the typed
 * `EdgeConfigItemNotFound`, which `get`/`has` absorb), while a bare 404
 * means the config itself (or the token) is invalid. Distilled's typed
 * errors are re-wrapped into this public error at the client boundary; the
 * original typed error rides `cause`.
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

/**
 * The per-call inputs the distilled `edge_config_data` operations take:
 * the connection string's origin IS the endpoint (local emulation hands out
 * `http://localhost:<port>` origins), the pathname is the config id.
 */
interface EdgeConfigCallTarget {
  readonly origin: string;
  readonly edgeConfigId: string;
  readonly token: string;
}

const toCallTarget = (
  connection: EdgeConfigConnection,
): EdgeConfigCallTarget => {
  const url = new URL(connection.baseUrl);
  return {
    origin: url.origin,
    edgeConfigId: url.pathname.slice(1),
    token: connection.token,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Effect client
// ─────────────────────────────────────────────────────────────────────────────

/** Every error a distilled Edge Config read operation can produce. */
type EdgeConfigDataError =
  | EdgeConfigData.GetEdgeConfigItemError
  | EdgeConfigData.GetEdgeConfigItemsError
  | EdgeConfigData.HasEdgeConfigItemError
  | EdgeConfigData.GetEdgeConfigDigestError;

/**
 * HTTP statuses of the typed distilled error tags — the public
 * {@link EdgeConfigReadError} keeps its `status` field even though the
 * generated errors carry the status in their tag instead.
 */
const READ_ERROR_STATUS: { readonly [tag: string]: number | undefined } = {
  EdgeConfigItemNotFound: 404,
  EdgeConfigNotFound: 404,
  EdgeConfigUnauthorized: 401,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Gone: 410,
  UnprocessableEntity: 422,
  Locked: 423,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
};

const statusOf = (cause: EdgeConfigDataError): number | undefined =>
  cause._tag === "HttpClientError"
    ? cause.response?.status
    : READ_ERROR_STATUS[cause._tag];

/**
 * Re-wrap a typed distilled error into the public
 * {@link EdgeConfigReadError} (boundary contract: the client's error
 * surface is unchanged; the typed error rides `cause`).
 */
const wrapReadError =
  (operation: string) =>
  (cause: EdgeConfigDataError): EdgeConfigReadError =>
    new EdgeConfigReadError({
      message: `Edge Config ${operation} failed: ${cause.message}`,
      operation,
      status: statusOf(cause),
      cause,
    });

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
 * construction; every read goes through the distilled `edge_config_data`
 * operations (typed errors, per-call origin + bearer token).
 */
export const makeReadEdgeConfigClient = (
  connection:
    | string
    | Redacted.Redacted<string>
    | Effect.Effect<string | Redacted.Redacted<string> | undefined>,
): Effect.Effect<ReadEdgeConfigClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();

    const resolveConnection: Effect.Effect<
      EdgeConfigCallTarget,
      EdgeConfigReadError
    > = Effect.gen(function* () {
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
        try: () => toCallTarget(parseEdgeConfigConnectionString(value)),
        catch: (cause) =>
          readFailure(
            "connect",
            undefined,
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
      });
    });

    const get = <T = unknown>(
      key: string,
    ): Effect.Effect<T | undefined, EdgeConfigReadError> =>
      resolveConnection.pipe(
        Effect.flatMap(({ origin, edgeConfigId, token }) =>
          EdgeConfigData.getEdgeConfigItem({
            origin,
            token,
            edgeConfigId,
            key,
            version: "1",
          }).pipe(
            Effect.map((value) => value as T | undefined),
            Effect.catchTag("EdgeConfigItemNotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.mapError(wrapReadError("get")),
          ),
        ),
        Effect.provideContext(context),
      );

    const getAll = <
      T extends Record<string, unknown> = Record<string, unknown>,
    >(
      keys?: readonly string[],
    ): Effect.Effect<T, EdgeConfigReadError> =>
      resolveConnection.pipe(
        Effect.flatMap(({ origin, edgeConfigId, token }) =>
          EdgeConfigData.getEdgeConfigItems({
            origin,
            token,
            edgeConfigId,
            version: "1",
            ...(keys === undefined ? {} : { keys: [...keys] }),
          }).pipe(
            Effect.map((items) => items as T),
            Effect.mapError(wrapReadError("getAll")),
          ),
        ),
        Effect.provideContext(context),
      );

    const has = (key: string): Effect.Effect<boolean, EdgeConfigReadError> =>
      resolveConnection.pipe(
        Effect.flatMap(({ origin, edgeConfigId, token }) =>
          EdgeConfigData.hasEdgeConfigItem({
            origin,
            token,
            edgeConfigId,
            key,
            version: "1",
          }).pipe(
            Effect.as(true),
            Effect.catchTag("EdgeConfigItemNotFound", () =>
              Effect.succeed(false),
            ),
            Effect.mapError(wrapReadError("has")),
          ),
        ),
        Effect.provideContext(context),
      );

    const digest = (): Effect.Effect<string, EdgeConfigReadError> =>
      resolveConnection.pipe(
        Effect.flatMap(({ origin, edgeConfigId, token }) =>
          EdgeConfigData.getEdgeConfigDigest({
            origin,
            token,
            edgeConfigId,
            version: "1",
          }).pipe(Effect.mapError(wrapReadError("digest"))),
        ),
        Effect.provideContext(context),
      );

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
 * `fromEnv`-style constructor for **plain async Functions**: resolves the
 * connection string from the given env var at call time (handling both raw
 * connection strings and alchemy's marker-packed sensitive values) and
 * reads via the distilled `edge_config_data` operations, surfacing failures
 * as plain `Error`s (the typed distilled error rides `cause`). For Effect
 * code use {@link ReadEdgeConfig} (bound) or
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
  const connect = (): EdgeConfigCallTarget => {
    const unpacked = unpackEnvValue<unknown>(process.env[envKey]);
    const value = Redacted.isRedacted(unpacked)
      ? (Redacted.value(unpacked) as string)
      : unpacked;
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `readEdgeConfigFromEnv(${envKey}): env var is not set — bind an EdgeConfigToken connection string to it`,
      );
    }
    return toCallTarget(parseEdgeConfigConnectionString(value));
  };
  const run = async <A>(
    operation: string,
    effect: Effect.Effect<A, EdgeConfigDataError, HttpClient.HttpClient>,
  ): Promise<A> => {
    const result = await Effect.runPromise(
      Effect.result(effect).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    if (Result.isFailure(result)) {
      const cause = result.failure;
      const status = statusOf(cause);
      throw new Error(
        `readEdgeConfigFromEnv(${envKey}).${operation}: ${
          status !== undefined ? `HTTP ${status}: ` : ""
        }${cause.message}`,
        { cause },
      );
    }
    return result.success;
  };
  // Methods are `async` so a synchronous `connect()` failure (missing env
  // var, malformed connection string) surfaces as a rejection, not a throw.
  return {
    get: async (key) =>
      run(
        "get",
        EdgeConfigData.getEdgeConfigItem({
          ...connect(),
          key,
          version: "1",
        }).pipe(
          Effect.map((value) => value as never),
          Effect.catchTag("EdgeConfigItemNotFound", () =>
            Effect.succeed(undefined as never),
          ),
        ),
      ),
    getAll: async (keys) =>
      run(
        "getAll",
        EdgeConfigData.getEdgeConfigItems({
          ...connect(),
          version: "1",
          ...(keys === undefined ? {} : { keys: [...keys] }),
        }).pipe(Effect.map((items) => items as never)),
      ),
    has: async (key) =>
      run(
        "has",
        EdgeConfigData.hasEdgeConfigItem({
          ...connect(),
          key,
          version: "1",
        }).pipe(
          Effect.as(true),
          Effect.catchTag("EdgeConfigItemNotFound", () =>
            Effect.succeed(false),
          ),
        ),
      ),
    digest: async () =>
      run(
        "digest",
        EdgeConfigData.getEdgeConfigDigest({ ...connect(), version: "1" }),
      ),
  };
};
