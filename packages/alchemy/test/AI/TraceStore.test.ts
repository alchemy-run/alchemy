/**
 * Conformance tests for the TraceStore protocol (design §2.7) against
 * the in-memory reference implementation: seq assignment inside the
 * commit, per-ring cursors, replay-then-tail with the no-gap guarantee,
 * and the durable/live split (deltas never stored, never sequenced).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as AI from "@/AI/index.ts";

const event = (
  ring: string,
  id: string,
  overrides?: Partial<AI.KernelEvent>,
): AI.KernelEvent => ({
  v: 1,
  type: "test",
  id,
  durable: true,
  ring: [ring],
  ...overrides,
});

describe("the in-memory TraceStore", () => {
  it.effect("commit assigns per-ring seq, atomically, in order", () =>
    Effect.gen(function* () {
      const store = yield* AI.makeMemoryTraceStore;
      const [a, b] = yield* store.commit([event("A", "a1"), event("A", "a2")]);
      const [c] = yield* store.commit([event("B", "b1")]);
      expect([a!.seq, b!.seq]).toEqual([1, 2]);
      expect(c!.seq).toBe(1); // ring B has its own cursor
    }),
  );

  it.effect("live deltas are published but never stored or sequenced", () =>
    Effect.gen(function* () {
      const store = yield* AI.makeMemoryTraceStore;
      const [delta] = yield* store.commit([
        event("A", "d1", { durable: false }),
      ]);
      expect(delta!.seq).toBeUndefined();
      yield* store.commit([event("A", "a1")]);
      const rows = yield* Stream.runCollect(
        store.trace("A").pipe(Stream.take(1)),
      );
      // the delta is invisible to the trace; the durable row is seq 1
      expect(rows.map((row) => [row.id, row.seq])).toEqual([["a1", 1]]);
    }),
  );

  it.effect("trace replays from a cursor, then tails live commits", () =>
    Effect.gen(function* () {
      const store = yield* AI.makeMemoryTraceStore;
      yield* store.commit([event("A", "a1"), event("A", "a2")]);

      // start the reader with a cursor past a1; it must see a2 (replay)
      // then a3 (tail) with no gap and no duplicates
      const reader = yield* Effect.forkChild(
        Stream.runCollect(store.trace("A", 1).pipe(Stream.take(2))),
      );
      yield* Effect.yieldNow;
      yield* store.commit([event("A", "a3")]);
      const rows = yield* Fiber.join(reader);
      expect(rows.map((row) => [row.id, row.seq])).toEqual([
        ["a2", 2],
        ["a3", 3],
      ]);
    }),
  );

  it.effect("the firehose sees everything, durable and live alike", () =>
    Effect.gen(function* () {
      const store = yield* AI.makeMemoryTraceStore;
      const reader = yield* Effect.forkChild(
        Stream.runCollect(store.events.pipe(Stream.take(3))),
      );
      yield* Effect.yieldNow;
      yield* store.commit([
        event("A", "a1"),
        event("A", "d1", { durable: false }),
        event("B", "b1"),
      ]);
      const seen = yield* Fiber.join(reader);
      expect(seen.map((e) => e.id)).toEqual(["a1", "d1", "b1"]);
    }),
  );
});
