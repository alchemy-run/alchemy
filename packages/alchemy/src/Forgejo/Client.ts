import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { AuthError, NeedsReauth } from "../Auth/AuthProvider.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import { UserFacingError } from "../UserFacingError.ts";
import {
  FORGEJO_AUTH_PROVIDER_NAME,
  type ForgejoAuthConfig,
  type ForgejoResolvedCredentials,
} from "./AuthProvider.ts";

/**
 * Configuration used to connect to a Forgejo instance.
 */
export interface ForgejoClientOptions {
  /**
   * Forgejo origin or API v1 base URL.
   */
  readonly baseUrl: string;
  /**
   * Forgejo access token.
   */
  readonly token: string | Redacted.Redacted<string>;
}

/**
 * Context shared by every Forgejo API failure.
 */
export interface ForgejoErrorContext {
  /**
   * HTTP method of the failed request.
   */
  readonly method: string;
  /**
   * API path of the failed request, relative to the API v1 base URL.
   */
  readonly path: string;
  /**
   * Response body returned by Forgejo.
   */
  readonly body: string;
}

/**
 * Render the request that failed, plus whatever Forgejo said about it.
 *
 * Nothing else gives these errors a message, so without this a failed
 * `alchemy destroy` reports `ForgejoServerError:` and nothing more.
 */
const describe = (
  error: ForgejoErrorContext & { readonly status?: number },
): string => {
  const status = error.status === undefined ? "" : ` -> ${error.status}`;
  const body = error.body === "" ? "" : `: ${error.body}`;
  return `${error.method} ${error.path}${status}${body}`;
};

/**
 * The requested resource does not exist. Lifecycle operations treat this as a
 * successful no-op when deleting, and as "needs creating" when reconciling.
 */
export class ForgejoNotFound extends Data.TaggedError(
  "ForgejoNotFound",
)<ForgejoErrorContext> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * The credential is missing, malformed, or expired.
 */
export class ForgejoUnauthorized extends Data.TaggedError(
  "ForgejoUnauthorized",
)<ForgejoErrorContext> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * The credential is valid but lacks permission for this operation. Forgejo
 * returns this for administrator-only endpoints reached with a user token.
 */
export class ForgejoForbidden extends Data.TaggedError(
  "ForgejoForbidden",
)<ForgejoErrorContext> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * The resource already exists, or the request conflicts with current state.
 * Reconcilers treat this as a create race and re-observe.
 */
export class ForgejoConflict extends Data.TaggedError(
  "ForgejoConflict",
)<ForgejoErrorContext> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * Forgejo rejected the request payload.
 */
export class ForgejoValidationError extends Data.TaggedError(
  "ForgejoValidationError",
)<ForgejoErrorContext> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * The operation cannot proceed until something that depends on the target is
 * gone — Forgejo's equivalent of a dependency violation.
 *
 * Forgejo answers it with a `500` rather than a conflict status, so it is
 * recognized by response body — see {@link DEPENDENCY_VIOLATION}. Lifecycle
 * operations retry it rather than failing the deploy.
 */
export class ForgejoDependencyViolation extends Data.TaggedError(
  "ForgejoDependencyViolation",
)<
  ForgejoErrorContext & {
    /**
     * HTTP status returned by Forgejo.
     */
    readonly status: number;
  }
> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * Forgejo returned a 5xx response.
 */
export class ForgejoServerError extends Data.TaggedError("ForgejoServerError")<
  ForgejoErrorContext & {
    /**
     * HTTP status returned by Forgejo.
     */
    readonly status: number;
  }
> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * Forgejo returned an unsuccessful status that maps to no more specific tag.
 */
export class ForgejoRequestError extends Data.TaggedError(
  "ForgejoRequestError",
)<
  ForgejoErrorContext & {
    /**
     * HTTP status returned by Forgejo.
     */
    readonly status: number;
  }
> {
  override get message(): string {
    return describe(this);
  }
}

/**
 * The request never produced a usable response: a connection failure, an
 * invalid URL, or an undecodable body.
 */
export class ForgejoTransportError extends Data.TaggedError(
  "ForgejoTransportError",
)<{
  /**
   * HTTP method of the failed request.
   */
  readonly method: string;
  /**
   * API path of the failed request, relative to the API v1 base URL.
   */
  readonly path: string;
  /**
   * Underlying transport or decoding failure.
   */
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.method} ${this.path}: ${String(this.cause)}`;
  }
}

/**
 * A list endpoint returned more pages than {@link MAX_PAGES} allows.
 *
 * Enumeration powers account-wide operations such as `alchemy nuke`, so a
 * silently truncated list would under-report and leave resources behind.
 */
export class ForgejoPaginationLimit extends Data.TaggedError(
  "ForgejoPaginationLimit",
)<{
  /**
   * API path being enumerated.
   */
  readonly path: string;
  /**
   * Number of pages walked before giving up.
   */
  readonly pages: number;
  /**
   * Entries requested per page.
   */
  readonly limit: number;
}> {
  /**
   * Human-readable description of the incomplete enumeration.
   */
  override get message(): string {
    return `Listing ${this.path} exceeded ${this.pages} pages of ${this.limit} entries; enumeration would be incomplete.`;
  }
}

/**
 * Every failure a Forgejo API request can produce.
 */
export type ForgejoError =
  | ForgejoNotFound
  | ForgejoUnauthorized
  | ForgejoForbidden
  | ForgejoConflict
  | ForgejoValidationError
  | ForgejoDependencyViolation
  | ForgejoServerError
  | ForgejoRequestError
  | ForgejoTransportError
  | ForgejoPaginationLimit;

/**
 * Normalize a Forgejo origin into its API v1 base URL.
 */
export const normalizeBaseUrl = (baseUrl: string): string => {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/api/v1") ? normalized : `${normalized}/api/v1`;
};

/**
 * Query parameters accepted by a Forgejo API request.
 */
export type ForgejoQuery = Readonly<
  Record<string, string | number | undefined>
>;

/**
 * Options accepted by the Forgejo client's request method.
 */
export interface ForgejoRequestOptions {
  /**
   * JSON request body.
   */
  readonly body?: unknown;
  /**
   * Query parameters appended to the request URL. Entries whose value is
   * `undefined` are omitted.
   */
  readonly query?: ForgejoQuery;
}

/**
 * Authenticated client for the Forgejo REST API.
 */
export interface ForgejoClient {
  /**
   * Normalized Forgejo API base URL.
   */
  readonly baseUrl: string;
  /**
   * Perform an authenticated API request and decode its JSON response.
   *
   * Resolves to `undefined` for empty responses, and fails with a tagged
   * error for every unsuccessful status.
   */
  readonly request: <T>(
    method: string,
    path: string,
    options?: ForgejoRequestOptions,
  ) => Effect.Effect<T, ForgejoError>;
}

/**
 * Credentials and client available to all Forgejo providers.
 */
export class ForgejoCredentials extends Context.Service<
  ForgejoCredentials,
  ForgejoClient
>()("Forgejo::Credentials") {}

/**
 * Body Forgejo returns for a 5xx that is really a dependency violation, and
 * the only signal separating one from a genuine server fault.
 *
 * Deleting an organization that still owns repositories answers `500` with
 * `{"message":"user still has ownership of repositories [uid: 16]"}`
 * (observed on Forgejo 16.0.3).
 */
const DEPENDENCY_VIOLATION = /still has ownership of repositories/i;

const statusError = (
  status: number,
  context: ForgejoErrorContext,
): ForgejoError => {
  if (status === 401) return new ForgejoUnauthorized(context);
  if (status === 403) return new ForgejoForbidden(context);
  if (status === 404) return new ForgejoNotFound(context);
  if (status === 409) return new ForgejoConflict(context);
  if (status === 422) return new ForgejoValidationError(context);
  if (status >= 500 && DEPENDENCY_VIOLATION.test(context.body))
    return new ForgejoDependencyViolation({ ...context, status });
  if (status >= 500) return new ForgejoServerError({ ...context, status });
  return new ForgejoRequestError({ ...context, status });
};

const withQuery = (path: string, query: ForgejoQuery | undefined): string => {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
};

const makeClient = (
  options: ForgejoClientOptions,
  httpClient: HttpClient.HttpClient,
): ForgejoClient => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token =
    typeof options.token === "string"
      ? options.token
      : Redacted.value(options.token);

  return {
    baseUrl,
    request: <T>(
      method: string,
      path: string,
      requestOptions?: ForgejoRequestOptions,
    ) =>
      Effect.gen(function* () {
        const url = `${baseUrl}${withQuery(path, requestOptions?.query)}`;
        const base = HttpClientRequest.make(method as "GET")(url).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/json",
            Authorization: `token ${token}`,
          }),
        );
        const request =
          requestOptions?.body === undefined
            ? base
            : HttpClientRequest.bodyJsonUnsafe(base, requestOptions.body);

        const response = yield* httpClient.execute(request);
        const text = yield* response.text;

        if (response.status < 200 || response.status >= 300) {
          return yield* statusError(response.status, {
            method,
            path,
            body: text,
          });
        }
        // Forgejo answers many mutations with `204 No Content`; callers that
        // ignore the result type this as `void`.
        if (text.length === 0) return undefined as T;
        return yield* Effect.try({
          try: () => JSON.parse(text) as T,
          catch: (cause) => new ForgejoTransportError({ method, path, cause }),
        });
      }).pipe(
        Effect.catchTag(
          "HttpClientError",
          (cause) => new ForgejoTransportError({ method, path, cause }),
        ),
      ),
  };
};

/**
 * Resolve a request that is allowed to be missing, mapping a not-found
 * failure to `undefined`.
 */
export const optional = <A, R>(
  effect: Effect.Effect<A, ForgejoError, R>,
): Effect.Effect<A | undefined, Exclude<ForgejoError, ForgejoNotFound>, R> =>
  effect.pipe(
    Effect.catchTag("ForgejoNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Resolve a request that is allowed to be missing or inaccessible.
 *
 * Account-wide enumeration walks resources the credential may not be able to
 * read; a single inaccessible repository or organization must not abort the
 * whole sweep.
 */
export const ignoreInaccessible = <A, R>(
  effect: Effect.Effect<A, ForgejoError, R>,
  fallback: A,
): Effect.Effect<
  A,
  Exclude<ForgejoError, ForgejoNotFound | ForgejoForbidden>,
  R
> =>
  effect.pipe(
    Effect.catchTag(["ForgejoNotFound", "ForgejoForbidden"], () =>
      Effect.succeed(fallback),
    ),
  );

/**
 * Largest page size Forgejo accepts on its paginated list endpoints.
 */
const PAGE_LIMIT = 50;

/**
 * Upper bound on pages walked by {@link paginate}, so a server that never
 * reports a short page cannot spin forever.
 */
const MAX_PAGES = 100;

/**
 * Walk every page of a Forgejo list endpoint.
 *
 * Forgejo paginates list responses (30 entries by default), so a single
 * request silently truncates enumeration. Paging stops at the first empty
 * page — not the first short one, since the instance may clamp the page size
 * below {@link PAGE_LIMIT}. Hitting {@link MAX_PAGES} fails with
 * {@link ForgejoPaginationLimit} rather than returning a list that only looks
 * complete.
 */
export const paginate = <T>(
  client: ForgejoClient,
  path: string,
  options?: {
    /**
     * Additional query parameters sent with every page request.
     */
    readonly query?: ForgejoQuery;
  },
): Effect.Effect<readonly T[], ForgejoError> => {
  const go = (
    page: number,
    accumulated: readonly T[],
  ): Effect.Effect<readonly T[], ForgejoError> =>
    client
      .request<readonly T[] | undefined>("GET", path, {
        query: { ...options?.query, page, limit: PAGE_LIMIT },
      })
      .pipe(
        Effect.flatMap((items) => {
          const combined =
            items === undefined ? accumulated : [...accumulated, ...items];
          // Stop only on an empty page, never on a short one. Forgejo clamps
          // the requested `limit` to the instance's `[api] MAX_RESPONSE_ITEMS`,
          // so on a server whose administrator lowered that below PAGE_LIMIT
          // every full page looks short — treating short as "last" would end
          // enumeration after page one and silently report a partial list as
          // complete.
          if (items === undefined || items.length === 0) {
            return Effect.succeed(combined);
          }
          return page >= MAX_PAGES
            ? new ForgejoPaginationLimit({
                path,
                pages: MAX_PAGES,
                limit: PAGE_LIMIT,
              })
            : go(page + 1, combined);
        }),
      );

  return go(1, []);
};

/**
 * Build a credentials layer from a Forgejo URL and access token.
 */
export const fromToken = (options: ForgejoClientOptions) =>
  Layer.effect(
    ForgejoCredentials,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      return makeClient(options, httpClient);
    }),
  );

/**
 * Raised when environment authentication is requested without the required
 * variables.
 */
export class MissingForgejoEnvironment extends Data.TaggedError(
  "MissingForgejoEnvironment",
)<{
  /**
   * Names of the environment variables that were not set.
   */
  readonly missing: readonly string[];
}> {
  /**
   * Human-readable description of the missing configuration.
   */
  override get message(): string {
    return `Set ${this.missing.join(" and ")} to use Forgejo providers.`;
  }
}

/**
 * Build a credentials layer from `FORGEJO_URL` and `FORGEJO_TOKEN`.
 */
export const fromEnv = () =>
  Layer.effect(
    ForgejoCredentials,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const baseUrl = yield* Effect.sync(() => process.env.FORGEJO_URL);
      const token = yield* Effect.sync(() => process.env.FORGEJO_TOKEN);
      const missing = [
        ...(baseUrl === undefined ? ["FORGEJO_URL"] : []),
        ...(token === undefined ? ["FORGEJO_TOKEN"] : []),
      ];
      if (baseUrl === undefined || token === undefined) {
        return yield* new MissingForgejoEnvironment({ missing });
      }
      return makeClient({ baseUrl, token }, httpClient);
    }),
  );

/**
 * Raised when neither the selected profile nor the CI environment yields a
 * usable Forgejo credential.
 */
export class UnresolvedForgejoCredentials extends Data.TaggedError(
  "UnresolvedForgejoCredentials",
)<{
  /**
   * Where resolution was attempted, e.g. `profile 'default'`.
   */
  readonly source: string;
  /**
   * Underlying auth-provider failure.
   */
  readonly cause: unknown;
}> {
  readonly [UserFacingError] = true;

  /**
   * Human-readable description of the failed resolution.
   */
  override get message(): string {
    return (
      `Failed to resolve Forgejo credentials from ${this.source}. ` +
      "Run `alchemy profile edit --add Forgejo`, or set FORGEJO_URL and " +
      "FORGEJO_TOKEN."
    );
  }
}

/**
 * Build a credentials layer from the selected alchemy profile, falling back
 * to `FORGEJO_URL` / `FORGEJO_TOKEN` in CI.
 *
 * This is what `providers()` uses when no explicit `{ baseUrl, token }` is
 * passed, so `alchemy profile edit --add Forgejo` is enough to authenticate
 * a stack.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    ForgejoCredentials,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const { profileName, resolve } = yield* resolveProviderConfig<
        ForgejoAuthConfig,
        ForgejoResolvedCredentials
      >(FORGEJO_AUTH_PROVIDER_NAME);

      // `resolve` is a union of the environment-branch and profile-branch
      // effects, whose error channels differ. Widen it to their common
      // supertype: piping the union directly infers `unknown` requirements,
      // which silently poisons `StackServices` for every consumer.
      const resolved: Effect.Effect<
        ForgejoResolvedCredentials,
        AuthError | NeedsReauth
      > = resolve;

      const credentials = yield* resolved.pipe(
        Effect.mapError(
          (cause) =>
            new UnresolvedForgejoCredentials({
              source:
                profileName === undefined
                  ? "the CI environment"
                  : `profile '${profileName}'`,
              cause,
            }),
        ),
        Effect.orDie,
      );

      return makeClient(
        { baseUrl: credentials.baseUrl, token: credentials.token },
        httpClient,
      );
    }),
  );
