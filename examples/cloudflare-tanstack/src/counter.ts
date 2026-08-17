// Narrow subpath imports (never the `alchemy/Cloudflare` barrel): this
// module joins the TanStack Start vite graph via the backend.
import * as KV from "alchemy/Cloudflare/KV";
import * as Workers from "alchemy/Cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Visits } from "./resources.ts";

/**
 * Durable Object with typed RPC methods. Registered on the Worker by
 * `yield* Counter` in the backend program — binding, SQLite migration, and
 * the class export in the generated worker entry all derive from that one
 * registration.
 */
export class Counter extends Workers.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const kv = yield* KV.ReadWriteNamespace(Visits);
    return Effect.gen(function* () {
      return {
        // Instance-scoped monotonic counter (per DO name) — proves the
        // namespace routes repeat calls to the same instance.
        increment: Effect.fn(function* (by: number) {
          const key = "do-count";
          const next = Number((yield* kv.get(key)) ?? "0") + by;
          yield* kv.put(key, String(next));
          return next;
        }, Effect.orDie),
        // RPC streaming: a bounded tick stream consumed by the caller.
        ticks: (n: number) =>
          Stream.iterate(0, (i) => i + 1).pipe(
            Stream.take(n),
            Stream.schedule(Schedule.spaced("50 millis")),
          ),
      };
    });
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
