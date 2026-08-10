/**
 * The `ThreadStorage` CONTRACT, asserted against both local
 * implementations — the same suite runs over `MemoryThreadStorage`
 * and `SqliteThreadStorage`, so a third implementation (a new
 * substrate) can copy these assertions as its conformance test.
 *
 * What the contract guarantees (what `DriverCore` relies on):
 *
 * - messages append in order and read back verbatim (encoded rows);
 * - `replaceMessages` is compaction's one mutation;
 * - `appendObservation` persists the row AND the meta cursor
 *   together; `observations(fromSeq)` replays from any cursor;
 * - `keys(term)` lists sessions with persisted meta (the restore
 *   surface) and `remove` drops a settled session entirely.
 */
import type { SessionObservation } from "@/AI/EventStream.ts";
import { MemoryThreadStorage, ThreadStorage } from "@/AI/ThreadStorage.ts";
import { SqliteThreadStorage } from "@/SQLite/ThreadStorage.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const observation = (seq: number): SessionObservation =>
  ({
    type: "input",
    term: "TestAgent",
    key: "issue-7",
    seq,
    at: Date.now(),
    text: `input ${seq}`,
  }) as SessionObservation;

const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as const;

const contract = (
  name: string,
  storageLayer: Effect.Effect<Layer.Layer<ThreadStorage>, any, any>,
) =>
  describe(name, () => {
    it.effect("messages: append in order, read back, replace", () =>
      Effect.gen(function* () {
        const layer = yield* storageLayer;
        yield* Effect.gen(function* () {
          const storage = yield* ThreadStorage;
          const handle = yield* storage.open("TestAgent", "issue-7");
          expect(yield* handle.meta).toBeUndefined();
          expect(yield* handle.messages).toEqual([]);

          yield* handle.appendMessages([user("one")]);
          yield* handle.appendMessages([user("two"), user("three")]);
          const rows = yield* handle.messages;
          expect(rows.length).toBe(3);
          expect(JSON.stringify(rows[0])).toContain("one");
          expect(JSON.stringify(rows[2])).toContain("three");

          // compaction's one mutation
          yield* handle.replaceMessages([user("summary")]);
          const replaced = yield* handle.messages;
          expect(replaced.length).toBe(1);
          expect(JSON.stringify(replaced[0])).toContain("summary");
          // appends continue after a replace
          yield* handle.appendMessages([user("four")]);
          expect((yield* handle.messages).length).toBe(2);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("observations ride their meta cursor atomically", () =>
      Effect.gen(function* () {
        const layer = yield* storageLayer;
        yield* Effect.gen(function* () {
          const storage = yield* ThreadStorage;
          const handle = yield* storage.open("TestAgent", "issue-7");
          yield* handle.appendObservation(observation(0), {
            tick: 0,
            observed: 1,
            active: [],
          });
          yield* handle.appendObservation(observation(1), {
            tick: 1,
            observed: 2,
            active: ["coding"],
          });
          const meta = yield* handle.meta;
          expect(meta).toEqual({ tick: 1, observed: 2, active: ["coding"] });
          expect((yield* handle.observations(0)).length).toBe(2);
          // replay from a cursor: only the tail
          const tail = yield* handle.observations(1);
          expect(tail.length).toBe(1);
          expect(tail[0]!.seq).toBe(1);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("inbox: enqueue, list above watermark, atomic admit", () =>
      Effect.gen(function* () {
        const layer = yield* storageLayer;
        yield* Effect.gen(function* () {
          const storage = yield* ThreadStorage;
          const handle = yield* storage.open("TestAgent", "issue-9");
          const s0 = yield* handle.putInbox("first");
          const s1 = yield* handle.putInbox({ event: "second" });
          expect(s1).toBeGreaterThan(s0);
          const pending = yield* handle.listInbox;
          expect(pending.map((row) => row.input)).toEqual([
            "first",
            { event: "second" },
          ]);

          // the atomic admit: messages + watermark + meta in one write
          yield* handle.admit({
            messages: [user("first")],
            drainedTo: s1 + 1,
            meta: {
              tick: 0,
              observed: 0,
              active: [],
              busy: { attempts: 0, since: 123 },
            },
          });
          // rows below the watermark are never re-admitted, even
          // before deleteInbox runs (the crash window)
          expect(yield* handle.listInbox).toEqual([]);
          expect((yield* handle.messages).length).toBe(1);
          expect((yield* handle.meta)?.busy).toEqual({
            attempts: 0,
            since: 123,
          });
          yield* handle.deleteInbox([s0, s1]);
          // a later enqueue is visible again
          const s2 = yield* handle.putInbox("third");
          expect(s2).toBeGreaterThan(s1);
          expect((yield* handle.listInbox).length).toBe(1);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("keys lists persisted sessions; remove drops them", () =>
      Effect.gen(function* () {
        const layer = yield* storageLayer;
        yield* Effect.gen(function* () {
          const storage = yield* ThreadStorage;
          const a = yield* storage.open("TestAgent", "issue-1");
          yield* a.putMeta({ tick: 3, observed: 5, active: [] });
          const b = yield* storage.open("TestAgent", "issue-2");
          yield* b.putMeta({ tick: 0, observed: 1, active: [] });
          // a different term never leaks into this term's keys
          const other = yield* storage.open("OtherAgent", "issue-1");
          yield* other.putMeta({ tick: 0, observed: 0, active: [] });

          const keys = yield* storage.keys("TestAgent");
          expect([...keys].sort()).toEqual(["issue-1", "issue-2"]);

          // a settled session disappears from the restore surface
          yield* storage.remove("TestAgent", "issue-1");
          expect(yield* storage.keys("TestAgent")).toEqual(["issue-2"]);
          const reopened = yield* storage.open("TestAgent", "issue-1");
          expect(yield* reopened.meta).toBeUndefined();
          expect(yield* reopened.messages).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
    );
  });

contract("MemoryThreadStorage", Effect.succeed(MemoryThreadStorage));

contract(
  "SqliteThreadStorage",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "thread-storage-" });
    return SqliteThreadStorage(path.join(dir, "runs.sqlite"));
  }),
);
