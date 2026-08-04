import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  SpacetimeDBCredentials,
  type SpacetimeDBCredentialsService,
} from "./Credentials.ts";

/**
 * Description returned by `GET /v1/database/:name_or_identity`.
 *
 * @see https://spacetimedb.com/docs/http/database#get-v1databasename_or_identity
 */
export interface DatabaseInfo {
  readonly databaseIdentity: string;
  readonly ownerIdentity: string;
  readonly hostType: string;
  /** Hash of the WASM module the database was initialized with. */
  readonly initialProgram: string;
}

/**
 * Result of a successful `POST`/`PUT /v1/database` publish.
 *
 * @see https://spacetimedb.com/docs/http/database#put-v1databasename_or_identity
 */
export interface PublishResult {
  readonly databaseIdentity: string;
  readonly domain: string | null;
  readonly op: "created" | "updated";
}

export class SpacetimeDBHttpError extends Data.TaggedError(
  "SpacetimeDBHttpError",
)<{
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: string;
}> {}

export class SpacetimeDBNotFound extends Data.TaggedError(
  "SpacetimeDBNotFound",
)<{
  readonly nameOrIdentity: string;
}> {}

export class SpacetimeDBPermissionDenied extends Data.TaggedError(
  "SpacetimeDBPermissionDenied",
)<{
  readonly nameOrIdentity: string;
}> {}

export class SpacetimeDBDecodeError extends Data.TaggedError(
  "SpacetimeDBDecodeError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SpacetimeDBClient {
  readonly credentials: SpacetimeDBCredentialsService;
  readonly getDatabase: (
    nameOrIdentity: string,
  ) => Effect.Effect<
    DatabaseInfo,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBDecodeError
  >;
  readonly publish: (
    nameOrIdentity: string,
    module: Uint8Array,
    options?: { readonly clear?: boolean },
  ) => Effect.Effect<
    PublishResult,
    SpacetimeDBHttpError | SpacetimeDBPermissionDenied | SpacetimeDBDecodeError
  >;
  readonly deleteDatabase: (
    nameOrIdentity: string,
  ) => Effect.Effect<
    void,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBPermissionDenied
  >;
  readonly listDatabaseIdentities: (
    ownerIdentity: string,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    SpacetimeDBHttpError | SpacetimeDBDecodeError
  >;
  readonly getDatabaseNames: (
    nameOrIdentity: string,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBDecodeError
  >;
  /**
   * Invoke a reducer or procedure via
   * `POST /v1/database/:name/call/:reducer` with a JSON argument array.
   */
  readonly call: (
    nameOrIdentity: string,
    reducer: string,
    args?: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    unknown,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBDecodeError
  >;
  /**
   * Run SQL against a database via `POST /v1/database/:name/sql`.
   */
  readonly sql: (
    nameOrIdentity: string,
    query: string,
  ) => Effect.Effect<
    ReadonlyArray<SqlStatementResult>,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBDecodeError
  >;
  /**
   * Fetch recent log lines via `GET /v1/database/:name/logs`.
   */
  readonly getLogs: (
    nameOrIdentity: string,
    options?: { readonly numLines?: number; readonly follow?: boolean },
  ) => Effect.Effect<
    string,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBPermissionDenied
  >;
  /**
   * Stream log lines with `?follow=true` (chunked HTTP). Emits decoded text
   * chunks until the connection ends.
   */
  readonly streamLogs: (
    nameOrIdentity: string,
  ) => Stream.Stream<
    string,
    SpacetimeDBHttpError | SpacetimeDBNotFound | SpacetimeDBPermissionDenied
  >;
}

/**
 * One statement result from `POST /v1/database/:name/sql`.
 */
export interface SqlStatementResult {
  readonly schema: unknown;
  readonly rows: ReadonlyArray<unknown>;
}

/**
 * Decode the `sub` (subject) claim of a SpacetimeDB JWT without verifying the
 * signature. Used only to discover the caller's identity for list/enumerate.
 */
export const decodeTokenIdentity = (
  token: string,
): Effect.Effect<string, SpacetimeDBDecodeError> =>
  Effect.try({
    try: () => {
      const parts = token.split(".");
      if (parts.length < 2 || !parts[1]) {
        throw new Error("JWT must have at least two segments");
      }
      const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const json =
        typeof atob === "function"
          ? atob(padded)
          : Buffer.from(padded, "base64").toString("utf8");
      const payload = JSON.parse(json) as { sub?: unknown; identity?: unknown };
      const sub =
        typeof payload.sub === "string"
          ? payload.sub
          : typeof payload.identity === "string"
            ? payload.identity
            : undefined;
      if (!sub) {
        throw new Error("JWT payload is missing a string `sub` claim");
      }
      return sub;
    },
    catch: (cause) =>
      new SpacetimeDBDecodeError({
        message: "Failed to decode SpacetimeDB token identity",
        cause,
      }),
  });

const snakeToCamelDatabase = (raw: Record<string, unknown>): DatabaseInfo => ({
  databaseIdentity: String(raw.database_identity ?? raw.databaseIdentity ?? ""),
  ownerIdentity: String(raw.owner_identity ?? raw.ownerIdentity ?? ""),
  hostType: String(raw.host_type ?? raw.hostType ?? "wasm"),
  initialProgram: String(raw.initial_program ?? raw.initialProgram ?? ""),
});

const parsePublishResult = (
  raw: unknown,
): Effect.Effect<
  PublishResult,
  SpacetimeDBPermissionDenied | SpacetimeDBDecodeError
> => {
  if (raw === null || typeof raw !== "object") {
    return Effect.fail(
      new SpacetimeDBDecodeError({
        message: `Unexpected publish response: ${JSON.stringify(raw)}`,
      }),
    );
  }
  const obj = raw as Record<string, unknown>;
  if ("PermissionDenied" in obj) {
    const denied = obj.PermissionDenied as { name?: string } | null;
    return Effect.fail(
      new SpacetimeDBPermissionDenied({
        nameOrIdentity: denied?.name ?? "unknown",
      }),
    );
  }
  const success = (obj.Success ?? obj) as Record<string, unknown>;
  const identity = success.database_identity ?? success.databaseIdentity;
  if (typeof identity !== "string") {
    return Effect.fail(
      new SpacetimeDBDecodeError({
        message: `Publish response missing database_identity: ${JSON.stringify(raw)}`,
      }),
    );
  }
  const op = success.op === "updated" ? "updated" : "created";
  const domain =
    typeof success.domain === "string"
      ? success.domain
      : success.domain === null
        ? null
        : null;
  return Effect.succeed({
    databaseIdentity: identity,
    domain,
    op,
  });
};

/**
 * Build a typed SpacetimeDB HTTP client over the ambient credentials +
 * HttpClient. Prefer resolving via {@link SpacetimeDBClient} Effect.
 */
export const makeClient = (
  credentials: SpacetimeDBCredentialsService,
  http: HttpClient.HttpClient,
): SpacetimeDBClient => {
  const base = credentials.host.replace(/\/+$/, "");
  const token = Redacted.value(credentials.token);

  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(HttpClientRequest.bearerToken(token));

  const execute = <A, E>(
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, E>,
  ) =>
    http.execute(authorized(request)).pipe(
      Effect.mapError(
        (cause) =>
          new SpacetimeDBHttpError({
            status: 0,
            method: request.method,
            url: request.url,
            body: String(cause),
          }),
      ),
      Effect.flatMap(handle),
    );

  const getDatabase = (nameOrIdentity: string) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}`;
    return execute(HttpClientRequest.get(url), (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "GET",
            url,
            body,
          });
        }
        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SpacetimeDBDecodeError({
                message: "Failed to parse database info JSON",
                cause,
              }),
          ),
        );
        return snakeToCamelDatabase(raw as Record<string, unknown>);
      }),
    );
  };

  const publish = (
    nameOrIdentity: string,
    module: Uint8Array,
    options?: { readonly clear?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (options?.clear) params.set("clear", "true");
    const qs = params.toString();
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}${qs ? `?${qs}` : ""}`;
    const request = HttpClientRequest.put(url).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/octet-stream"),
      HttpClientRequest.bodyUint8Array(module, "application/octet-stream"),
    );
    return execute(request, (response) =>
      Effect.gen(function* () {
        const bodyText = yield* response.text.pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (response.status === 401 || response.status === 403) {
          return yield* new SpacetimeDBPermissionDenied({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "PUT",
            url,
            body: bodyText,
          });
        }
        let raw: unknown = bodyText;
        try {
          raw = bodyText ? JSON.parse(bodyText) : {};
        } catch (cause) {
          return yield* new SpacetimeDBDecodeError({
            message: "Failed to parse publish response JSON",
            cause,
          });
        }
        return yield* parsePublishResult(raw);
      }),
    );
  };

  const deleteDatabase = (nameOrIdentity: string) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}`;
    return execute(HttpClientRequest.delete(url), (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status === 401 || response.status === 403) {
          return yield* new SpacetimeDBPermissionDenied({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "DELETE",
            url,
            body,
          });
        }
      }),
    );
  };

  const listDatabaseIdentities = (ownerIdentity: string) => {
    const url = `${base}/v1/identity/${encodeURIComponent(ownerIdentity)}/databases`;
    return execute(HttpClientRequest.get(url), (response) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "GET",
            url,
            body,
          });
        }
        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SpacetimeDBDecodeError({
                message: "Failed to parse identity databases JSON",
                cause,
              }),
          ),
        );
        const identities = (raw as { identities?: unknown }).identities;
        if (!Array.isArray(identities)) {
          return yield* new SpacetimeDBDecodeError({
            message: `Expected { identities: string[] }, got ${JSON.stringify(raw)}`,
          });
        }
        return identities.map(String);
      }),
    );
  };

  const getDatabaseNames = (nameOrIdentity: string) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}/names`;
    return execute(HttpClientRequest.get(url), (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "GET",
            url,
            body,
          });
        }
        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SpacetimeDBDecodeError({
                message: "Failed to parse database names JSON",
                cause,
              }),
          ),
        );
        const names = (raw as { names?: unknown }).names;
        if (!Array.isArray(names)) {
          return yield* new SpacetimeDBDecodeError({
            message: `Expected { names: string[] }, got ${JSON.stringify(raw)}`,
          });
        }
        return names.map(String);
      }),
    );
  };

  const call = (
    nameOrIdentity: string,
    reducer: string,
    args: ReadonlyArray<unknown> = [],
  ) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}/call/${encodeURIComponent(reducer)}`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJsonUnsafe(args),
    );
    return execute(request, (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "POST",
            url,
            body,
          });
        }
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        if (!text) return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      }),
    );
  };

  const sql = (nameOrIdentity: string, query: string) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}/sql`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(query, "text/plain"),
    );
    return execute(request, (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "POST",
            url,
            body,
          });
        }
        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SpacetimeDBDecodeError({
                message: "Failed to parse SQL response JSON",
                cause,
              }),
          ),
        );
        if (!Array.isArray(raw)) {
          return yield* new SpacetimeDBDecodeError({
            message: `Expected SQL result array, got ${JSON.stringify(raw)}`,
          });
        }
        return raw.map((item) => {
          const row = item as { schema?: unknown; rows?: unknown };
          return {
            schema: row.schema,
            rows: Array.isArray(row.rows) ? row.rows : [],
          } satisfies SqlStatementResult;
        });
      }),
    );
  };

  const getLogs = (
    nameOrIdentity: string,
    options?: { readonly numLines?: number; readonly follow?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (options?.numLines !== undefined) {
      params.set("num_lines", String(options.numLines));
    }
    if (options?.follow) params.set("follow", "true");
    const qs = params.toString();
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}/logs${qs ? `?${qs}` : ""}`;
    return execute(HttpClientRequest.get(url), (response) =>
      Effect.gen(function* () {
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status === 401 || response.status === 403) {
          return yield* new SpacetimeDBPermissionDenied({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "GET",
            url,
            body,
          });
        }
        return yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      }),
    );
  };

  const streamLogs = (nameOrIdentity: string) => {
    const url = `${base}/v1/database/${encodeURIComponent(nameOrIdentity)}/logs?follow=true`;
    return Stream.unwrap(
      Effect.gen(function* () {
        const response = yield* http
          .execute(authorized(HttpClientRequest.get(url)))
          .pipe(
            Effect.mapError(
              (cause) =>
                new SpacetimeDBHttpError({
                  status: 0,
                  method: "GET",
                  url,
                  body: String(cause),
                }),
            ),
          );
        if (response.status === 404) {
          return yield* new SpacetimeDBNotFound({ nameOrIdentity });
        }
        if (response.status === 401 || response.status === 403) {
          return yield* new SpacetimeDBPermissionDenied({ nameOrIdentity });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* new SpacetimeDBHttpError({
            status: response.status,
            method: "GET",
            url,
            body,
          });
        }
        // Stream decoded text chunks from the response body.
        return response.stream.pipe(
          Stream.decodeText(),
          Stream.mapError(
            (cause) =>
              new SpacetimeDBHttpError({
                status: response.status,
                method: "GET",
                url,
                body: String(cause),
              }),
          ),
        );
      }),
    );
  };

  return {
    credentials,
    getDatabase,
    publish,
    deleteDatabase,
    listDatabaseIdentities,
    getDatabaseNames,
    call,
    sql,
    getLogs,
    streamLogs,
  };
};

/**
 * Resolve a {@link SpacetimeDBClient} from ambient credentials + HttpClient.
 */
export const SpacetimeDBClient: Effect.Effect<
  SpacetimeDBClient,
  never,
  SpacetimeDBCredentials | HttpClient.HttpClient
> = Effect.gen(function* () {
  const credentials = yield* yield* SpacetimeDBCredentials;
  const http = yield* HttpClient.HttpClient;
  return makeClient(credentials, http);
});
