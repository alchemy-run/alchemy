import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PersistentRef from "../../PersistentRef.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

/**
 * A `PersistentRef.Store` over Durable Object storage — the
 * synchronous SQLite-backed KV (`ctx.storage.kv`). Writes are local
 * and immediately consistent; write coalescing batches them and the
 * output gate holds any outgoing message until they are durable. A
 * storage failure crashes the DO into a retry (a defect), which is
 * the at-least-once doctrine.
 *
 * Rows are namespaced under `prefix` so refs share storage safely with
 * whatever else the Durable Object persists.
 */
export const makeDurableObjectStore = (
  state: DurableObjectState["Service"],
  options?: { readonly prefix?: string },
): PersistentRef.StoreService => {
  const prefix = options?.prefix ?? "alchemy:ref:";
  // The tuple → flat-key mapping is THIS store's job; `pathKey` is the
  // canonical collision-free path encoding.
  const rowKey = (key: PersistentRef.StoreKey) =>
    prefix + PersistentRef.pathKey(key);
  return {
    load: (key) => Effect.sync(() => state.storage.kv.get(rowKey(key))),
    write: (key, encoded) =>
      Effect.sync(() => void state.storage.kv.put(rowKey(key), encoded)),
  };
};

/**
 * Layer form, for providing `PersistentRef.Store` inside any alchemy
 * Durable Object (the `DurableObjectState` service is already in scope
 * in a DO constructor's context).
 *
 * ```ts
 * Effect.provide(Cloudflare.DurableObjectPersistentRefStore())
 * ```
 */
export const DurableObjectPersistentRefStore = (options?: {
  readonly prefix?: string;
}): Layer.Layer<PersistentRef.Store, never, DurableObjectState> =>
  Layer.effect(
    PersistentRef.Store,
    Effect.map(DurableObjectState, (state) =>
      makeDurableObjectStore(state, options),
    ),
  );
