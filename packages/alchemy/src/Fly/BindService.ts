import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import { makeFetchRpcStub, RPC_PATH_PREFIX, type Rpc } from "../Rpc.ts";
import {
  CurrentRuntimeContext,
  type RuntimeContext,
  sanitizeKey,
} from "../RuntimeContext.ts";
import { isYieldableEffectLike } from "../Util/effect.ts";
import type { BoundTarget, ServiceBinding } from "./MountVolume.ts";
import { RPC_TOKEN_HEADER } from "./rpc.ts";
import type { Service } from "./Service.ts";

/** The deployed caller has no address for the bound Service. */
export class BoundServiceUnavailable extends Data.TaggedError(
  "Fly.BoundServiceUnavailable",
)<{
  service: string;
}> {
  get message() {
    return `No private address for Fly Service ${this.service}. It publishes no ports, or the caller was deployed before the binding existed.`;
  }
}

/**
 * Client for a Service bound with {@link bindService}: its RPC methods,
 * plus `fetch` for its HTTP routes.
 */
export type ServiceClient<Shape> = Omit<Shape, "fetch" | "run"> & {
  /**
   * Send a request to the Service's `fetch` handler over Fly's private
   * network. A relative URL such as `/users/u1` resolves against the
   * Service's private address.
   */
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | BoundServiceUnavailable,
    RuntimeContext
  >;
};

/** A published port of a Service bound with {@link bindEndpoint}. */
export interface EndpointClient {
  /** `{appName}.flycast`, the bound Service's private hostname. */
  host: Effect.Effect<string, BoundServiceUnavailable, RuntimeContext>;
  /** The published port. */
  port: number;
  /** `http://{appName}.flycast:{port}`, for a port that serves plain HTTP. */
  url: Effect.Effect<string, BoundServiceUnavailable, RuntimeContext>;
  /** An `HttpClient` whose relative requests go to {@link url}. */
  client: HttpClient.HttpClient.With<
    HttpClientError.HttpClientError | BoundServiceUnavailable
  >;
}

type Target<Shape> = Service & Rpc<Shape>;

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

/** Logical id without yielding the Service (the runtime has no engine). */
const logicalIdOf = (target: unknown): string => {
  const id =
    target !== null &&
    (typeof target === "object" || typeof target === "function")
      ? (target as { LogicalId?: unknown }).LogicalId
      : undefined;
  return typeof id === "string" ? id : "";
};

/** Machine env vars the caller's reconcile writes for a bound Service. */
export const boundTargetEnvKeys = (id: string) => ({
  appName: sanitizeKey(`FLY_BIND_${id}_APP`),
  url: sanitizeKey(`FLY_BIND_${id}_URL`),
  token: sanitizeKey(`FLY_BIND_${id}_TOKEN`),
});

/**
 * Record the binding on the caller and transport the target's private
 * address and caller token as Outputs. Returns runtime accessors for them.
 */
const bindTarget = Effect.fn(function* <Shape, Req>(
  target: Target<Shape> | Effect.Effect<Target<Shape>, never, Req>,
  port: number | undefined,
) {
  const id = logicalIdOf(target);
  const keys = boundTargetEnvKeys(id);
  const ctx = yield* CurrentRuntimeContext;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    // Yielding registers the target and makes the caller depend on it.
    const service = isYieldableEffectLike(target)
      ? yield* target as Effect.Effect<Target<Shape>, never, Req>
      : target;
    // The binding carries the target's Outputs. Unlike props, binding
    // data may stay unresolved between cycle peers, so two Services can
    // bind each other; the caller's reconcile writes them onto its Machines.
    const host = yield* Binding.Host;
    if (isFlyHost(host)) {
      yield* host.bind`${service}`({
        target: {
          service: id,
          appName: service.appName,
          network: service.network,
          privateUrl: service.privateUrl,
          rpcToken: service.rpcToken,
          port,
          endpoints: service.endpoints,
        } as unknown as BoundTarget,
      });
    }
  }
  // Captured at bind time: the host's runtime context reads the values
  // transported onto the Machine.
  const read = (key: string) =>
    ctx === undefined ? Effect.succeed(undefined) : ctx.get<unknown>(key);
  const required = (key: string) =>
    read(key).pipe(
      Effect.flatMap((value) =>
        typeof value === "string" && value.length > 0
          ? Effect.succeed(value)
          : Effect.fail(new BoundServiceUnavailable({ service: id })),
      ),
    );
  return {
    appName: required(keys.appName),
    url: required(keys.url),
    token: read(keys.token).pipe(
      Effect.map((value) =>
        Redacted.isRedacted(value)
          ? String(Redacted.value(value))
          : typeof value === "string"
            ? value
            : "",
      ),
    ),
  };
});

/** Resolve `path` (relative or placeholder-based) against `base`. */
const withBase = (base: string, url: string) => {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
};

/**
 * Bind another {@link Service} and get a typed client for it. The client
 * calls the Service's methods (everything it returns besides `fetch` and
 * `run`) and forwards `fetch` requests, over Fly's private network.
 *
 * Binding makes the caller deploy after the Service, records the binding
 * so reconcile can check the Service is reachable, and hands the caller
 * the Service's private address and caller token. Only callers that bind
 * a Service receive its token, so other Services on the same network
 * cannot call its methods.
 *
 * **Example:** Call a private Service
 * ```typescript
 * export default class Orders extends Fly.Service<Orders>()(
 *   "Orders",
 *   { main: import.meta.url, public: false },
 *   Effect.gen(function* () {
 *     const users = yield* Fly.bindService(Users);
 *     return {
 *       listOrders: () =>
 *         Effect.forEach(ORDERS, (order) =>
 *           users
 *             .getUser(order.userId)
 *             .pipe(Effect.map((user) => ({ ...order, user }))),
 *         ),
 *     };
 *   }),
 * ) {}
 * ```
 */
export const bindService = <Shape, Req = never>(
  target: Target<Shape> | Effect.Effect<Target<Shape>, never, Req>,
): Effect.Effect<ServiceClient<Shape>, never, Req | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const bound = yield* bindTarget(target, undefined);
    const send = (
      request: HttpClientRequest.HttpClientRequest,
      isRpc: boolean,
    ) =>
      Effect.gen(function* () {
        const base = yield* bound.url;
        let next = HttpClientRequest.setUrl(
          request,
          withBase(base, request.url),
        );
        if (isRpc) {
          next = HttpClientRequest.setHeader(
            next,
            RPC_TOKEN_HEADER,
            yield* bound.token,
          );
        }
        return yield* http.execute(next);
      });
    return makeFetchRpcStub<ServiceClient<Shape>>({
      fetch: (request) =>
        send(request, request.url.includes(RPC_PATH_PREFIX)) as Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          unknown
        >,
      base: {
        fetch: (request: HttpClientRequest.HttpClientRequest) =>
          send(request, false),
      },
    });
  });

/**
 * Bind one published port of another {@link Service}. Use it for a port
 * other than the Service's main HTTP port, such as an admin API on its own
 * port or a raw TCP protocol. Reconcile fails with
 * `Fly.EndpointNotPublished` when the Service does not publish `port`.
 *
 * **Example:** An admin API on port 9000
 * ```typescript
 * const admin = yield* Fly.bindEndpoint(Admin, { port: 9000 });
 * const response = yield* admin.client.get("/stats");
 * ```
 *
 * **Example:** A raw TCP port
 * ```typescript
 * const cache = yield* Fly.bindEndpoint(Cache, { port: 6379 });
 * const host = yield* cache.host; // "{appName}.flycast"
 * ```
 */
export const bindEndpoint = <Shape, Req = never>(
  target: Target<Shape> | Effect.Effect<Target<Shape>, never, Req>,
  options: { port: number },
): Effect.Effect<EndpointClient, never, Req | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const bound = yield* bindTarget(target, options.port);
    const host = bound.appName.pipe(Effect.map((app) => `${app}.flycast`));
    const url = host.pipe(
      Effect.map((name) =>
        options.port === 80
          ? `http://${name}`
          : `http://${name}:${options.port}`,
      ),
    );
    return {
      host,
      port: options.port,
      url,
      client: HttpClient.mapRequestEffect(http, (request) =>
        url.pipe(
          Effect.map((base) =>
            HttpClientRequest.setUrl(request, withBase(base, request.url)),
          ),
        ),
      ),
    } satisfies EndpointClient;
  });
