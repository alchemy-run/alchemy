/**
 * A typed Effect `RpcClient` over a Durable Object namespace whose stubs
 * expose an Effect `fetch` — the client half of `RpcDurableObject`, shared
 * by every engine.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";

export const bindEffectRpc = <Rpcs extends Rpc.Any>(
  namespace: {
    readonly getByName: (id: string, options?: any) => { readonly fetch: any };
  },
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    /**
     * Override the rpc serialization layer. Defaults to NDJSON, which
     * is required when any rpc in the group is a streaming rpc.
     */
    readonly serialization?: Layer.Layer<RpcSerialization.RpcSerialization>;
  },
): {
  readonly getByName: (
    id: string,
    options?: any,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
} => {
  const serialization = options?.serialization ?? RpcSerialization.layerNdjson;

  return {
    // Wrap the cached `RpcClient` Effect in a chainable Proxy so callers
    // can `yield* counter.getByName(id).method(args)` directly. The proxy
    // records the `.method(args)` ops and replays them against the
    // resolved client when the chain is yielded.
    getByName: Effect.fn(function* (id: string, options?: any) {
      const httpClient = HttpClient.layerMergedContext(
        Effect.sync(() => {
          const stub = namespace.getByName(id, options);
          return HttpClient.make((request) => stub.fetch(request));
        }),
      );
      const protocol = RpcClient.layerProtocolHttp({ url: "http://alchemy-rpc/" }).pipe(
        Layer.provide(serialization),
        Layer.provide(httpClient),
      );
      return yield* RpcClient.make(group).pipe(Effect.provide(protocol));
    }) as any,
  };
};
