/**
 * The celld flavor of Durable Object hosting — the two per-engine
 * variation points `Workers/DurableObject.ts` leaves to the host, plus the
 * per-instance state service a fleet-hosted object reads.
 *
 * A fleet executes the same `Cloudflare.DurableObject` classes (and the
 * same bridge runtime) a Cloudflare Worker does, so the state/storage
 * services ARE the engine-invariant ones — re-exported here so fleet code
 * reads `Celld.DurableObjectState` without reaching into `Cloudflare`.
 */
import type * as cf from "@cloudflare/workers-types";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { fromCloudflareFetcher } from "../Cloudflare/Fetcher.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import type {
  DurableObjectBindingDeclaration,
  DurableObjectStubLike,
} from "../Workers/DurableObject.ts";

export {
  DurableObjectState,
  fromDurableObjectState,
} from "../Workers/DurableObject.ts";
export type {
  DurableObjectStorage,
  DurableObjectTransaction,
  SqlCursor,
  SqlStorage,
} from "../Workers/DurableObjectStorage.ts";

/**
 * Host-native binding data for a class declaration: the worker's binding
 * contract carries plain DO declarations, not Cloudflare's `bindings`
 * array.
 */
export const durableObjectBinding = (
  decl: DurableObjectBindingDeclaration,
) => ({
  durableObjects: [{ name: decl.name, className: decl.className }],
});

/**
 * The celld stub flavor: alchemy's fetch-RPC over the native namespace
 * stub. Celld namespace stubs speak fetch, not workerd JSRPC (celld's
 * JSRPC dispatch stalls on Proxy-returning constructors), and the cell's
 * bridge serves the RPC protocol on its own `fetch`.
 */
export const durableObjectStub = (nativeStub: DurableObjectStubLike) => {
  const fetcher = fromCloudflareFetcher(nativeStub as unknown as cf.Fetcher);
  return makeFetchRpcStub<Record<string, unknown>>({
    fetch: (request: HttpClientRequest.HttpClientRequest) =>
      fetcher.fetch(request),
    base: {
      fetch: (request: HttpServerRequest.HttpServerRequest) =>
        fetcher.fetch(request),
    },
  });
};
