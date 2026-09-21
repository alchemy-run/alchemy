import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  CounterBoom,
  type CounterShape,
} from "../../../Cloudflare/Workers/conformance/counter-shape.ts";

export class Counter extends Celld.DurableObject<Counter, CounterShape>()(
  "Counter",
) {}

export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Celld.DurableObjectState;
    return Effect.gen(function* () {
      return {
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
        sqlClear: () =>
          Effect.gen(function* () {
            yield* (yield* state.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS entries (v TEXT)",
            )).toArray();
            yield* (yield* state.storage.sql.exec(
              "DELETE FROM entries",
            )).toArray();
          }),
        sqlInsert: (value: string) =>
          Effect.gen(function* () {
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
        armAlarm: (ms: number) =>
          Effect.gen(function* () {
            const now = yield* Effect.sync(() => Date.now());
            yield* state.storage.setAlarm(now + ms);
          }),
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
        tick: (n: number) =>
          Stream.range(1, n).pipe(
            Stream.schedule(Schedule.spaced("10 millis")),
          ),
        boom: () => Effect.fail(new CounterBoom({ reason: "expected" })),
      } satisfies CounterShape;
    });
  }),
);
