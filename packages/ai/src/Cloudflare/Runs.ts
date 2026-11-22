/**
 * Where a harness in a Durable Object records its runs, and the alarm that
 * finishes one an evicted instance left behind.
 *
 * @internal
 * @module
 */
import { DurableObjectCallbacks } from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type { Callbacks } from "alchemy/Callback";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RunStore } from "../Runs.ts";

interface KeyValue {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** A Durable Object's own storage as a run store, and its alarm as the runs' callbacks. */
export const durableObjectRuns = (
  state: DurableObjectState["Service"],
  prefix: string,
): { readonly store: RunStore; readonly callbacks: Layer.Layer<Callbacks> } => {
  const storage = (state.raw as unknown as { storage: KeyValue }).storage;
  return {
    store: {
      get: (key) => Effect.tryPromise(() => storage.get(`${prefix}:${key}`)),
      put: (key, value) => Effect.tryPromise(() => storage.put(`${prefix}:${key}`, value)),
      delete: (key) => Effect.asVoid(Effect.tryPromise(() => storage.delete(`${prefix}:${key}`))),
    },
    callbacks: DurableObjectCallbacks.pipe(Layer.provide(Layer.succeed(DurableObjectState, state))),
  };
};
