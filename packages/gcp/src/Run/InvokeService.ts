import * as Binding from "alchemy/Binding";
import { type Rpc, makeFetchRpcStub } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpMethod } from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { Rpc as EffectRpc, RpcClient, RpcGroup } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as Semaphore from "effect/Semaphore";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { makeHttpApiClient, makeRpcGroupClient } from "./EffectApis.ts";
import type { Service } from "./Service.ts";

/** Request options for {@link InvokeServiceClient.fetch}. */
export interface InvokeServiceRequestInit {
  /** HTTP method. @default "GET" */
  method?: string;
  /** Extra request headers. `Authorization` is always set by the binding. */
  headers?: Record<string, string>;
  /** Request body; objects are not serialized — pass a string. */
  body?: string | Uint8Array;
}

/** A fully buffered response from the bound service. */
export interface InvokeServiceResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Response headers (lower-cased names). */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body as text. */
  readonly text: Effect.Effect<string>;
  /** The response body parsed as JSON. */
  readonly json: Effect.Effect<unknown, InvokeServiceError>;
}

/**
 * Runtime client returned by {@link InvokeService}: the target's RPC
 * methods, `fetch` for its HTTP routes, and an `httpClient` for anything
 * else (an Effect RPC or HttpApi client, streaming responses).
 */
export type InvokeServiceClient<Shape = {}> = Omit<Shape, "fetch" | "run"> & {
  /**
   * Call the bound service at `path` (relative to its `uri`) with a
   * Google-signed ID token for the host's runtime service account.
   */
  fetch(
    path: string,
    init?: InvokeServiceRequestInit,
  ): Effect.Effect<InvokeServiceResponse, InvokeServiceError, RuntimeContext>;
  /**
   * An `HttpClient` that signs every request with an ID token for the
   * service. A relative URL such as `/orders` resolves against its `uri`.
   */
  httpClient: HttpClient.HttpClient.With<HttpClientError.HttpClientError | InvokeServiceError>;
};

/** The RPC shape a Cloud Run service class declares, if any. */
type ShapeOf<Target> = Target extends Rpc<infer Shape> ? Shape : {};

/**
 * Minting the ID token, reaching the service, or decoding its response
 * failed. Non-2xx responses are not errors — inspect `status`.
 */
export class InvokeServiceError extends Data.TaggedError("GCP.Run.InvokeServiceError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Runtime binding that calls a private Cloud Run {@link Service} from
 * another Cloud Run host with Google-signed identity — the GCP analog of
 * `AWS.Lambda.InvokeFunction`.
 *
 * At deploy time it grants `roles/run.invoker` on the target service to
 * the host's runtime service account and binds the target's `uri` into
 * the host. At runtime it mints an ID token (audience = the target `uri`)
 * from the metadata server, caches it until shortly before expiry, and
 * sends it as `Authorization: Bearer`. The target keeps
 * `invokerIamDisabled` off, so anything without a token gets `403`.
 *
 * Provide {@link InvokeServiceHttp}.
 *
 * ### Calling a private service
 * **Example:** Forward a request to a private backend
 * ```typescript
 * export default class Gateway extends GCP.Function<Gateway>()(
 *   "Gateway",
 *   { main: import.meta.url, invokerIamDisabled: true },
 *   Effect.gen(function* () {
 *     const quotes = yield* GCP.Run.InvokeService(Quotes);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* quotes.fetch("/quote").pipe(Effect.orDie);
 *         return HttpServerResponse.text(yield* response.text, {
 *           status: response.status,
 *         });
 *       }),
 *     };
 *   }).pipe(Effect.provide(GCP.Run.InvokeServiceHttp)),
 * ) {}
 * ```
 *
 * **Example:** POST a JSON body
 * ```typescript
 * const response = yield* orders.fetch("/orders", {
 *   method: "POST",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ sku: "abc", quantity: 1 }),
 * });
 * const order = yield* response.json;
 * ```
 *
 * ### Calling RPC methods
 * **Example:** Methods on a private service
 * ```typescript
 * export default class Quotes extends GCP.Run.Service<Quotes>()(
 *   "Quotes",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       quote: (symbol: string) => Effect.succeed({ symbol, price: 42 }),
 *       ticks: (symbol: string) => Stream.make(41, 42, 43),
 *     };
 *   }),
 * ) {}
 * ```
 * Keep the service's IAM invoker check on: a service that returns
 * methods and sets `invokerIamDisabled` fails to deploy with
 * `GCP.Run.ServiceRpcPublic`.
 *
 * **Example:** Call them from another service
 * ```typescript
 * const quotes = yield* GCP.Run.InvokeService(Quotes);
 * const { price } = yield* quotes.quote("GOOG");
 * const ticks = yield* quotes.ticks("GOOG").pipe(Stream.take(3), Stream.runCollect);
 * ```
 *
 * ### Bring your own client
 * **Example:** `httpClient` signs every request
 * ```typescript
 * const response = yield* quotes.httpClient.get("/health");
 * ```
 *
 * @binding
 * @category Run
 */
/** `fetch` and `httpClient` of a bound service, alongside a typed client. */
export type InvokeServiceTransport = Pick<InvokeServiceClient, "fetch" | "httpClient">;

/** The API a bound service serves, when it is an Effect RPC group or HttpApi. */
export type InvokeServiceOptions =
  | { schema: RpcGroup.RpcGroup<EffectRpc.Any> }
  | { api: HttpApi.HttpApi<string, HttpApiGroup.Constraint> };

export interface InvokeService extends Binding.Service<
  InvokeService,
  "GCP.Run.InvokeService",
  (service: Service, options?: InvokeServiceOptions) => Effect.Effect<InvokeServiceClient>
> {
  <Target extends Service, Req = never>(
    service: Target | Effect.Effect<Target, never, Req>,
  ): Effect.Effect<InvokeServiceClient<ShapeOf<Target>>, never, InvokeService | Req>;
  <Rpcs extends EffectRpc.Any, Req = never>(
    service: Service | Effect.Effect<Service, never, Req>,
    options: { schema: RpcGroup.RpcGroup<Rpcs> },
  ): Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & InvokeServiceTransport,
    never,
    InvokeService | Req
  >;
  <Groups extends HttpApiGroup.Constraint, Req = never>(
    service: Service | Effect.Effect<Service, never, Req>,
    options: { api: HttpApi.HttpApi<string, Groups> },
  ): Effect.Effect<
    HttpApiClient.Client<Groups, HttpClientError.HttpClientError | InvokeServiceError> &
      InvokeServiceTransport,
    never,
    InvokeService | Req
  >;
}

export const InvokeService = Binding.Service<InvokeService>("GCP.Run.InvokeService");

const IDENTITY_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Refresh this long before the token's `exp`. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Google ID tokens live one hour; used when `exp` cannot be decoded. */
const DEFAULT_LIFETIME_MS = 55 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** Epoch millis of a JWT's `exp` claim, if present. */
const jwtExpiry = (token: string): number | undefined => {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

/** Mint a Google-signed ID token for `audience` from the metadata server. */
const fetchIdToken = (http: HttpClient.HttpClient, audience: string) =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(IDENTITY_ENDPOINT).pipe(
        HttpClientRequest.setUrlParams({ audience, format: "full" }),
        HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
      ),
    );
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new InvokeServiceError({
        message: `GCE metadata identity endpoint returned HTTP ${response.status}: ${body}`,
      });
    }
    const token = body.trim();
    const now = yield* Clock.currentTimeMillis;
    return {
      token,
      expiresAt: jwtExpiry(token) ?? now + DEFAULT_LIFETIME_MS,
    } satisfies CachedToken;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InvokeServiceError
        ? cause
        : new InvokeServiceError({
            message: `GCE metadata identity endpoint is unreachable: ${String(cause)}`,
            cause,
          }),
    ),
  );

/** Single-flight, expiry-aware ID token cache for one audience. */
const makeIdTokenCache = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<CachedToken | undefined>(undefined);
    const lock = yield* Semaphore.make(1);
    const fresh = (current: CachedToken | undefined, now: number) =>
      current !== undefined && current.expiresAt - REFRESH_WINDOW_MS > now;
    return (audience: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(cache);
        if (fresh(current, yield* Clock.currentTimeMillis)) {
          return current!.token;
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const latest = yield* Ref.get(cache);
            if (fresh(latest, yield* Clock.currentTimeMillis)) {
              return latest!.token;
            }
            const minted = yield* fetchIdToken(http, audience);
            yield* Ref.set(cache, minted);
            return minted.token;
          }),
        );
      });
  });

/**
 * HTTP implementation of {@link InvokeService}: ID tokens from the Cloud
 * Run metadata server, requests over the ambient `HttpClient`.
 *
 * @layer
 * @provides GCP.Run.InvokeService
 */
export const InvokeServiceHttp: Layer.Layer<InvokeService, never, HttpClient.HttpClient> =
  Layer.effect(
    InvokeService,
    Effect.gen(function* () {
      const bind = yield* GCPBindings.Bind;
      const http = yield* HttpClient.HttpClient;
      return Effect.fn(function* <T extends Service>(service: T, options?: InvokeServiceOptions) {
        yield* GCPBindings.requireServiceAccountHost("GCP.Run.InvokeService");
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* bind`GCP.Run.InvokeService(${service})`({
            iam: [grantFor({ role: "roles/run.invoker", on: "run.service" }, service.name)],
          });
        }
        const uri = yield* service.uri;
        const idToken = yield* makeIdTokenCache(http);

        const fetch = Effect.fn(`GCP.Run.InvokeService(${service.LogicalId})`)(function* (
          path: string,
          init?: InvokeServiceRequestInit,
        ) {
          const base = yield* uri;
          if (base === undefined) {
            return yield* new InvokeServiceError({
              message: `Cloud Run service ${service.LogicalId} has no URI`,
            });
          }
          const audience = base.replace(/\/+$/, "");
          const token = yield* idToken(audience);
          const url = `${audience}/${path.replace(/^\/+/, "")}`;
          let request = HttpClientRequest.make(
            (init?.method?.toUpperCase() ?? "GET") as HttpMethod,
          )(url).pipe(
            HttpClientRequest.setHeaders(init?.headers ?? {}),
            HttpClientRequest.bearerToken(token),
          );
          if (init?.body !== undefined) {
            const contentType = init.headers?.["content-type"] ?? init.headers?.["Content-Type"];
            request =
              typeof init.body === "string"
                ? HttpClientRequest.bodyText(request, init.body, contentType)
                : HttpClientRequest.bodyUint8Array(request, init.body, contentType);
          }
          const response = yield* http.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new InvokeServiceError({
                  message: `Request to ${url} failed: ${cause.message}`,
                  cause,
                }),
            ),
          );
          const text = yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new InvokeServiceError({
                  message: `Reading the response from ${url} failed: ${cause.message}`,
                  cause,
                }),
            ),
          );
          return {
            status: response.status,
            headers: { ...response.headers },
            text: Effect.succeed(text),
            json: Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: (cause) =>
                new InvokeServiceError({
                  message: `Response from ${url} is not JSON`,
                  cause,
                }),
            }),
          } satisfies InvokeServiceResponse;
        });
        const signed = (request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            const base = yield* uri;
            if (base === undefined) {
              return yield* new InvokeServiceError({
                message: `Cloud Run service ${service.LogicalId} has no URI`,
              });
            }
            const audience = base.replace(/\/+$/, "");
            const token = yield* idToken(audience);
            const url = /^[a-z]+:\/\//i.test(request.url)
              ? request.url
              : `${audience}/${request.url.replace(/^\/+/, "")}`;
            return request.pipe(
              HttpClientRequest.setUrl(url),
              HttpClientRequest.bearerToken(token),
            );
          });
        const httpClient = HttpClient.mapRequestEffect(http, signed);
        // RPC methods post to `/__rpc__/<name>` on the service with the
        // same ID token; the service serves them only behind its IAM
        // invoker check.
        const transport = { fetch, httpClient };
        if (options !== undefined && "schema" in options) {
          return Object.assign(
            makeRpcGroupClient(options.schema, httpClient as unknown as HttpClient.HttpClient),
            transport,
          ) as unknown as InvokeServiceClient;
        }
        if (options !== undefined && "api" in options) {
          return Object.assign(
            yield* makeHttpApiClient(options.api, httpClient),
            transport,
          ) as unknown as InvokeServiceClient;
        }
        return makeFetchRpcStub<InvokeServiceClient>({
          baseUrl: "",
          fetch: (request) =>
            httpClient.execute(request) as Effect.Effect<
              HttpClientResponse.HttpClientResponse,
              unknown
            >,
          base: transport,
        });
      });
    }),
  );
