/**
 * The entity the transport tests call: `Call` counts a run of `id`, then
 * takes `ms`; `Runs` answers how many times `id` has run, so a test sees
 * whether a call ran twice.
 */
import type { makeNamespace } from "@alchemy.run/effect-cluster/internal/Gateway";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

export const TOKEN = "transport-test";

export const Slow = Entity.make("Slow", [
  Rpc.make("Call", { payload: { id: Schema.String, ms: Schema.Number }, success: Schema.Number }),
  Rpc.make("Runs", { payload: { id: Schema.String }, success: Schema.Number }),
]);

/** `Slow` as the gateway takes any entity. */
export const AnySlow = Slow as unknown as Parameters<typeof makeNamespace>[0];

const runs = new Map<string, number>();

export const SlowLive = Slow.toLayer({
  Call: ({ payload }) =>
    Effect.sync(() => {
      const count = (runs.get(payload.id) ?? 0) + 1;
      runs.set(payload.id, count);
      return count;
    }).pipe(Effect.tap(() => Effect.sleep(`${payload.ms} millis`))),
  Runs: ({ payload }) => Effect.sync(() => runs.get(payload.id) ?? 0),
});
