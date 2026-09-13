/**
 * The celld Durable Object class: the engine-invariant instance core
 * (`Workers/DurableObjectBridge.ts`) through Cloudflare's workerd wrapper,
 * in **static** dispatch mode — celld's JSRPC stalls on Proxy-returning
 * constructors and cannot transfer `ReadableStream`s across the cell
 * boundary, so the RPC surface is materialized as real instance methods
 * and the fetch-RPC protocol is served on the instance's own `fetch`
 * (streams ride HTTP chunked bodies end to end).
 *
 * Bundled into the fleet worker: keep it free of node-only APIs.
 */
import type { DurableObject } from "cloudflare:workers";
import type * as Effect from "effect/Effect";
import { makeDurableObjectBridge } from "../Cloudflare/Workers/DurableObjectBridge.ts";

/** Build the exported bridge class for one hosted Durable Object class. */
export const makeCelldDurableObjectBridge = (
  DurableObjectClass: typeof DurableObject,
  entrypoint: Effect.Effect<Record<string, any>>,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
) => {
  const bridge = makeDurableObjectBridge(DurableObjectClass, {
    entrypoint,
    stack: { name: options.stack.name, stage: options.stack.stage },
  });
  return (className: string) => bridge(className, { dispatch: "static" });
};
