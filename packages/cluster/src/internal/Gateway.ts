/**
 * The gateway runners serve and callers reach entities through: each
 * entity's RPCs as an `EntityProxy` RPC group over HTTP, addressed by
 * entity id, behind a bearer token. A caller needs no database access and
 * no route to the runners, only the gateway's address and token.
 *
 * @internal
 */
import { type Entity, EntityProxy, EntityProxyServer } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { type Rpc, RpcClient, RpcGroup, RpcSchema, RpcSerialization, RpcServer } from "effect/rpc";
import * as Stream from "effect/Stream";

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
}

const groupOf = (entity: Entity.Entity<string, Rpc.Any>) =>
  EntityProxy.toRpcGroup(entity) as unknown as RpcGroup.RpcGroup<Rpc.Any>;

/**
 * A caller's client for one entity type: `client(entityId).Method(payload)`,
 * the same shape as Effect Cluster's own `Entity.client`. Each call opens
 * its own RPC client over `fetch`, so nothing outlives the request that
 * made it.
 */
export const makeGatewayClient = (
  entity: Entity.Entity<string, Rpc.Any>,
  target: GatewayTarget,
) => {
  const group = groupOf(entity);
  const protocol = RpcClient.layerProtocolHttp({
    url: `${target.url.replace(/\/+$/, "")}${GATEWAY_PATH}`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(target.token)),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  const client = RpcClient.make(group);

  return (entityId: string) => {
    const methods: Record<string, unknown> = {};
    for (const [tag, rpc] of entity.protocol.requests) {
      const proxyTag = `${entity.type}.${tag}`;
      const call = (payload: unknown) =>
        Effect.map(client, (rpcs) =>
          (rpcs as unknown as Record<string, (input: unknown) => unknown>)[proxyTag]!({
            entityId,
            payload,
          }),
        );
      methods[tag] = RpcSchema.isStreamSchema((rpc as Rpc.AnyWithProps).successSchema)
        ? (payload: unknown) =>
            Stream.unwrap(
              // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a stream RPC's client method returns its Stream
              call(payload) as Effect.Effect<Stream.Stream<unknown, unknown>, never, never>,
            ).pipe(Stream.scoped, Stream.provide(protocol))
        : (payload: unknown) =>
            Effect.flatMap(
              call(payload),
              (result) => result as Effect.Effect<unknown, unknown>,
            ).pipe(Effect.scoped, Effect.provide(protocol));
    }
    return methods;
  };
};

/**
 * The gateway a runner serves: every hosted entity's RPCs, behind the
 * token. Requires the runner's `Sharding`, which routes each call to the
 * runner that owns the entity.
 */
export const gatewayLayer = (
  entities: ReadonlyArray<Entity.Entity<string, Rpc.Any>>,
  token: string,
) => {
  const [first, ...rest] = entities.map(groupOf);
  const group = rest.reduce((all, next) => all.merge(next), first!);
  const handlers = Layer.mergeAll(
    ...(entities.map((entity) => EntityProxyServer.layerRpcHandlers(entity as any)) as [
      Layer.Layer<never, never, any>,
    ]),
  );
  const expected = `Bearer ${token}`;
  return HttpRouter.serve(
    RpcServer.layerHttp({ group, path: GATEWAY_PATH, protocol: "http" }).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcSerialization.layerJson),
    ),
    {
      disableListenLog: true,
      middleware: (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return request.headers.authorization === expected
            ? yield* app
            : HttpServerResponse.empty({ status: 401 });
        }),
    },
  );
};
