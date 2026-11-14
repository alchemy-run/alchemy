import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
/**
 * How callers reach entities. Inside the cluster (a runner, where
 * `Sharding` is in context) calls go straight through Effect Cluster's own
 * client. Anywhere else they go through the gateway the pool serves: each
 * entity's RPCs as an RPC group over HTTP, addressed by entity id, behind a
 * bearer token, so a caller needs no database access and no route to the
 * pool.
 *
 * Either way the caller's client middleware runs in the caller, and the
 * headers it sets reach the entity's own middleware on the runner.
 *
 * @internal
 */
import { type Entity, Sharding } from "effect/cluster";
import {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  PersistenceError,
} from "effect/cluster/ClusterError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Rpc,
  RpcClient,
  RpcGroup,
  type RpcMiddleware,
  RpcSchema,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Workflow, WorkflowEngine } from "effect/workflow";
import { WorkflowRpcs, workflowHandlers } from "./WorkflowGateway.ts";

/** The path every gateway serves its RPCs on. */
export const GATEWAY_PATH = "/rpc";

/** The port runners serve the gateway on inside their network. */
export const GATEWAY_PORT = 34500;

/** The port runners talk to each other on inside their network. */
export const RUNNER_PORT = 34431;

/** Where a caller reaches an entity, and how it proves it may. */
export interface GatewayTarget {
  readonly url: string;
  readonly token: string;
  /**
   * The environment key of a service binding to the gateway, when the
   * caller is a Worker and the gateway is one too: Workers can't fetch
   * another Worker's `workers.dev` URL in the same account.
   */
  readonly service?: string;
}

/**
 * Give the runtime being deployed a direct route, bound under `key`, to the
 * gateway Worker `worker`. A host whose gateway is a Worker registers one;
 * it binds nothing for a caller that isn't a Worker.
 */
export type RouteBinder = (key: string, worker: unknown) => Effect.Effect<void, never, any>;

const routeBinders: Array<RouteBinder> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("alchemy/Cluster/RouteBinders")
] ??= []) as Array<RouteBinder>;

/** The gateway Workers hosted types are served by, while deploying. */
const routedTypes: Map<string, unknown> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("alchemy/Cluster/RoutedTypes")
] ??= new Map()) as Map<string, unknown>;

/** Register a host's {@link RouteBinder}. @internal */
export const registerRouteBinder = (binder: RouteBinder) => {
  if (!routeBinders.includes(binder)) routeBinders.push(binder);
};

/** A host's gateway Worker serves `type` (an entity type, or `Workflow/${name}`). @internal */
export const routeType = (type: string, worker: unknown) => {
  routedTypes.set(type, worker);
};

/**
 * While deploying, bind a route to the gateway Worker serving `type` into
 * the runtime being deployed, under `key`. Returns the key when one exists.
 */
export const bindRoute = (type: string, key: string) =>
  Effect.gen(function* () {
    const worker = routedTypes.get(type);
    if (worker === undefined) return undefined;
    for (const binder of routeBinders) yield* binder(key, worker);
    return key;
  });

/**
 * The `fetch` of the service binding under `key`, inside a Worker that has
 * one; otherwise the global `fetch`.
 */
export const gatewayFetch = (key: string | undefined) =>
  Effect.map(Effect.serviceOption(WorkerEnvironment), (env) => {
    const service = key === undefined ? undefined : Option.getOrUndefined(env)?.[key];
    return typeof service?.fetch === "function"
      ? (service.fetch.bind(service) as typeof globalThis.fetch)
      : globalThis.fetch;
  });

type AnyEntity = Entity.Entity<string, Rpc.Any>;

const clientErrors = [MailboxFull, AlreadyProcessingMessage, PersistenceError] as const;
const requestErrors = [...clientErrors, EntityNotAssignedToRunner] as const;

/** The errors an RPC's middleware can fail with, which the gateway must carry too. */
const middlewareErrors = (rpc: Rpc.AnyWithProps) =>
  [...rpc.middlewares].map((middleware) => middleware.error);

/**
 * Each entity RPC as a gateway RPC: `${type}.${tag}` and its `Discard`
 * twin, taking the entity id, the payload and the caller's headers. Like
 * Effect Cluster's `EntityProxy`, plus the headers and middleware errors.
 */
const groupOf = (entity: AnyEntity) => {
  const rpcs: Array<Rpc.Any> = [];
  for (const parent_ of entity.protocol.requests.values()) {
    const parent = parent_ as unknown as Rpc.AnyWithProps;
    const payload = Schema.Struct({
      entityId: Schema.String,
      payload: parent.payloadSchema,
      headers: Schema.Record(Schema.String, Schema.String),
    });
    rpcs.push(
      Rpc.make(`${entity.type}.${parent._tag}`, {
        payload,
        error: Schema.Union([parent.errorSchema, ...middlewareErrors(parent), ...requestErrors]),
        success: parent.successSchema,
      }).annotateMerge(parent.annotations),
      Rpc.make(`${entity.type}.${parent._tag}Discard`, {
        payload,
        error: Schema.Union([...middlewareErrors(parent), ...clientErrors]),
      }).annotateMerge(parent.annotations),
    );
  }
  return RpcGroup.make(...rpcs) as RpcGroup.RpcGroup<Rpc.Any>;
};

interface CallOptions {
  readonly discard?: boolean;
  readonly headers?: Headers.Input;
}

/**
 * Run the caller's client middleware for `rpc` and return the headers it
 * set. Middleware is looked up the way `RpcClient` does, from the caller's
 * context (`RpcMiddleware.layerClient`); a middleware with no client side
 * is skipped.
 */
const clientHeaders = (
  services: Context.Context<never>,
  rpc: Rpc.AnyWithProps,
  payload: unknown,
  options: CallOptions | undefined,
) =>
  Effect.gen(function* () {
    let headers = Headers.merge(
      yield* RpcClient.CurrentHeaders,
      Headers.fromInput(options?.headers ?? {}),
    );
    const middlewares = [...rpc.middlewares].flatMap((tag) => {
      const client = services.mapUnsafe.get(`${tag.key}/Client`) as
        | RpcMiddleware.RpcMiddlewareClient<unknown, unknown, never>
        | undefined;
      return client === undefined ? [] : [client];
    });
    const loop = (request: any, index: number): Effect.Effect<any, unknown> =>
      index === -1
        ? Effect.sync(() => {
            headers = request.headers;
          })
        : middlewares[index]!({
            rpc,
            request,
            next: (next) => loop(next, index - 1),
          });
    yield* loop(
      { _tag: "Request", id: 0n, tag: rpc._tag, payload, headers },
      middlewares.length - 1,
    );
    return headers;
  });

/**
 * A caller's view of one entity type: `getByName(entityId)` returns a
 * client with the same shape as Effect Cluster's `Entity.client(entityId)`.
 */
export const makeNamespace = (entity: AnyEntity, target: GatewayTarget) => {
  const group = groupOf(entity);
  // NDJSON frames each message, so a streamed RPC delivers as it goes.
  const protocol = RpcClient.layerProtocolHttp({
    url: `${target.url.replace(/\/+$/, "")}${GATEWAY_PATH}`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(target.token)),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]));

  const getByName = (entityId: string) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<never>();
      // Inside the cluster, Effect Cluster routes the call itself.
      const sharding = Option.getOrUndefined(yield* Effect.serviceOption(Sharding.Sharding));
      const native =
        sharding === undefined
          ? undefined
          : ((yield* Effect.provideService(entity.client, Sharding.Sharding, sharding))(
              entityId,
            ) as unknown as Record<string, (payload: unknown, options: object) => any>);

      const methods: Record<string, unknown> = {};
      for (const [tag, rpc_] of entity.protocol.requests) {
        const rpc = rpc_ as unknown as Rpc.AnyWithProps;
        const isStream = RpcSchema.isStreamSchema(rpc.successSchema);
        const send = (payload: unknown, options: CallOptions | undefined) =>
          Effect.gen(function* () {
            const headers = yield* clientHeaders(services, rpc, payload, options);
            const discard = options?.discard === true;
            if (native !== undefined) return native[tag]!(payload, { headers, discard });
            const client = (yield* RpcClient.make(group)) as unknown as Record<
              string,
              (input: unknown) => any
            >;
            return client[`${entity.type}.${tag}${discard ? "Discard" : ""}`]!({
              entityId,
              payload,
              headers: Object.fromEntries(Object.entries(headers)),
            });
          });
        methods[tag] = isStream
          ? (payload: unknown, options?: CallOptions) =>
              Stream.unwrap(
                Effect.map(gatewayFetch(target.service), (fetch) =>
                  Stream.unwrap(send(payload, options)).pipe(
                    Stream.scoped,
                    Stream.provide(protocol),
                    Stream.provideService(FetchHttpClient.Fetch, fetch),
                  ),
                ),
              )
          : (payload: unknown, options?: CallOptions) =>
              Effect.flatMap(send(payload, options), (result) => result).pipe(
                Effect.scoped,
                Effect.provide(protocol),
                Effect.provideServiceEffect(FetchHttpClient.Fetch, gatewayFetch(target.service)),
              );
      }
      return methods;
    });

  return { getByName };
};

/**
 * The gateway handlers for one entity: each call goes to Effect Cluster's
 * own client with the caller's headers, so the entity's middleware sees
 * them. Requires the runner's `Sharding`, which routes each call to the
 * runner that owns the entity.
 */
const handlersOf = (entity: AnyEntity) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const client = yield* entity.client;
      const handlers = new Map<string, unknown>();
      for (const parent of entity.protocol.requests.values()) {
        const tag = `${entity.type}.${parent._tag}`;
        const call =
          (discard: boolean) =>
          ({
            entityId,
            payload,
            headers,
          }: {
            entityId: string;
            payload: unknown;
            headers: Record<string, string>;
          }) =>
            (client(entityId) as unknown as Record<string, (p: unknown, o: object) => unknown>)[
              parent._tag
            ]!(payload, { headers, discard });
        handlers.set(`effect/rpc/Rpc/${tag}`, { context, tag, handler: call(false) });
        handlers.set(`effect/rpc/Rpc/${tag}Discard`, {
          context,
          tag: `${tag}Discard`,
          handler: call(true),
        });
      }
      return Context.makeUnsafe(handlers) as Context.Context<never>;
    }),
  );

/**
 * What a gateway serves: one RPC group with every hosted entity's RPCs (and
 * the workflow RPCs, when it hosts workflows), and the handlers that route
 * each call to Effect Cluster.
 */
export const gatewayServer = (
  entities: ReadonlyArray<AnyEntity>,
  workflows: ReadonlyMap<string, Workflow.Any> = new Map(),
) => {
  const groups = [...entities.map(groupOf), ...(workflows.size > 0 ? [WorkflowRpcs] : [])];
  const [first, ...rest] = groups as [RpcGroup.RpcGroup<Rpc.Any>, ...RpcGroup.RpcGroup<Rpc.Any>[]];
  const group = rest.reduce((all, next) => all.merge(next), first ?? RpcGroup.make());
  const handlers = Layer.mergeAll(
    ...([
      ...entities.map(handlersOf),
      ...(workflows.size > 0 ? [workflowHandlers(workflows)] : []),
    ] as unknown as [Layer.Layer<never, never, Sharding.Sharding | WorkflowEngine.WorkflowEngine>]),
  );
  return { group, handlers };
};

/** Serve `app` to callers with the token; `/health` answers anyone. */
export const authorized =
  (token: string) =>
  <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Load balancers check the gateway without the token.
      if (request.url === "/health" || request.url.endsWith("/health")) {
        return HttpServerResponse.text("ok");
      }
      return request.headers.authorization === `Bearer ${token}`
        ? yield* app
        : HttpServerResponse.empty({ status: 401 });
    });

/** The gateway a runner serves: every hosted entity's RPCs, behind the token. */
export function gatewayLayer(
  entities: ReadonlyArray<AnyEntity>,
  token: string,
): Layer.Layer<never, never, Sharding.Sharding>;
/** With the workflows the runner hosts, served on its own `WorkflowEngine`. */
export function gatewayLayer(
  entities: ReadonlyArray<AnyEntity>,
  token: string,
  workflows: ReadonlyMap<string, Workflow.Any>,
): Layer.Layer<never, never, Sharding.Sharding | WorkflowEngine.WorkflowEngine>;
export function gatewayLayer(
  entities: ReadonlyArray<AnyEntity>,
  token: string,
  workflows: ReadonlyMap<string, Workflow.Any> = new Map(),
): Layer.Layer<never, never, any> {
  const { group, handlers } = gatewayServer(entities, workflows);
  return HttpRouter.serve(
    RpcServer.layerHttp({ group, path: GATEWAY_PATH, protocol: "http" }).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
    { disableListenLog: true, middleware: authorized(token) },
  );
}
