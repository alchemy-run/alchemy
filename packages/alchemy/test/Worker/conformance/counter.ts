/**
 * The shared conformance Durable Object — ONE implementation, deployed
 * unchanged to every engine. It exercises the whole portable surface:
 * KV storage, SQL storage, alarms, a `Stream`-returning method, and a
 * typed failure.
 *
 * Nothing here may reference an engine. If a line of this file has to
 * change for a particular platform, the portable abstraction has a hole.
 */
import * as Alchemy from "@/index.ts";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export class CounterBoom extends Data.TaggedError("CounterBoom")<{
  readonly reason: string;
}> {}

export interface CounterShape {
  increment: () => Effect.Effect<number, never, RuntimeContext>;
  get: () => Effect.Effect<number, never, RuntimeContext>;
  listKeys: (prefix: string) => Effect.Effect<string[], never, RuntimeContext>;
  removeKey: (key: string) => Effect.Effect<boolean, never, RuntimeContext>;
  sqlInsert: (value: string) => Effect.Effect<void, never, RuntimeContext>;
  sqlAll: () => Effect.Effect<{ v: string }[], never, RuntimeContext>;
  armAlarm: (ms: number) => Effect.Effect<void, never, RuntimeContext>;
  peekAlarm: () => Effect.Effect<number | null, never, RuntimeContext>;
  cancelAlarm: () => Effect.Effect<void, never, RuntimeContext>;
  firedCount: () => Effect.Effect<number, never, RuntimeContext>;
  tick: (n: number) => Stream.Stream<number, never, RuntimeContext>;
  boom: () => Effect.Effect<never, CounterBoom, RuntimeContext>;
  alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

export class Counter extends Alchemy.DurableObject<Counter, CounterShape>()(
  "Counter",
) {}

/**
 * The implementation layer — worker- and cloud-free. The hosting worker
 * is whichever deploy module's impl provides this layer; callers pipe a
 * `.ref` to reach it remotely.
 */
export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Alchemy.DurableObjectState;
    return Effect.gen(function* () {
      return {
        // ── KV ──────────────────────────────────────────────────
        increment: () =>
          Effect.gen(function* () {
            const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
        get: () =>
          Effect.gen(function* () {
            return (yield* state.storage.get<number>("count")) ?? 0;
          }),
        listKeys: (prefix: string) =>
          Effect.gen(function* () {
            const entries = yield* state.storage.list({ prefix });
            return [...entries.keys()];
          }),
        removeKey: (key: string) => state.storage.delete(key),

        // ── SQL ─────────────────────────────────────────────────
        sqlInsert: (value: string) =>
          Effect.gen(function* () {
            // `exec` yields a cursor; `toArray` drains it.
            yield* (yield* state.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS entries (v TEXT)",
            )).toArray();
            yield* (yield* state.storage.sql.exec(
              "INSERT INTO entries (v) VALUES (?)",
              value,
            )).toArray();
          }),
        sqlAll: () =>
          Effect.gen(function* () {
            yield* (yield* state.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS entries (v TEXT)",
            )).toArray();
            const cursor = yield* state.storage.sql.exec<{ v: string }>(
              "SELECT v FROM entries",
            );
            return yield* cursor.toArray();
          }),

        // ── Alarms ──────────────────────────────────────────────
        armAlarm: (ms: number) => state.storage.setAlarm(Date.now() + ms),
        peekAlarm: () => state.storage.getAlarm(),
        cancelAlarm: () => state.storage.deleteAlarm(),
        firedCount: () =>
          Effect.gen(function* () {
            return (yield* state.storage.get<number>("fired")) ?? 0;
          }),
        alarm: () =>
          Effect.gen(function* () {
            const next = ((yield* state.storage.get<number>("fired")) ?? 0) + 1;
            yield* state.storage.put("fired", next);
          }),

        // ── Streams / typed errors ──────────────────────────────
        tick: (n: number) =>
          Stream.range(1, n).pipe(
            Stream.schedule(Schedule.spaced("10 millis")),
          ),
        boom: () => Effect.fail(new CounterBoom({ reason: "expected" })),
      } satisfies CounterShape;
    });
  }),
);
