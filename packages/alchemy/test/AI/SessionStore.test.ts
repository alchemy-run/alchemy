import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { MemorySessionStore, SessionStore } from "@/AI/SessionStore.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SessionStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(MemorySessionStore)) as Effect.Effect<A, E, never>);

const delta = (text: string) =>
  ({ type: "message.delta", itemId: "m1", role: "assistant", text }) as const;

describe("AI.SessionStore", { tags: ["unit", "local"] }, () => {
  test("append stamps monotonic cursors per session", async () => {
    const cursors = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const a = yield* store.append("s1", delta("a"));
        const b = yield* store.append("s1", delta("b"));
        const other = yield* store.append("s2", delta("x"));
        return [a.cursor, b.cursor, other.cursor, a.sessionId];
      }),
    );
    expect(cursors).toEqual([1, 2, 1, "s1"]);
  });

  test("read replays after a cursor, then follows live appends without gaps", async () => {
    const texts = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore;
        yield* store.append("s1", delta("one"));
        yield* store.append("s1", delta("two"));
        const reader = yield* store
          .read("s1", { after: 1 })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* store.append("s1", delta("three"));
        yield* store.append("s1", delta("four"));
        const events = yield* Fiber.join(reader);
        return Array.from(events).map((e) => (e.type === "message.delta" ? e.text : e.type));
      }),
    );
    expect(texts).toEqual(["two", "three", "four"]);
  });

  test("a closed session's stream completes", async () => {
    const types = await run(
      Effect.gen(function* () {
        const store = yield* SessionStore;
        yield* store.append("s1", delta("bye"));
        yield* store.append("s1", { type: "state", state: "closed" });
        const events = yield* store.read("s1").pipe(Stream.runCollect);
        return Array.from(events).map((e) => e.type);
      }),
    );
    expect(types).toEqual(["message.delta", "state"]);
  });
});
