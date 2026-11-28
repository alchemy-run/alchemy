import * as Domain from "@alchemy.run/domain";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import * as Memory from "@alchemy.run/domain/InMemory";
import { Internals } from "@alchemy.run/domain/Model";
import { describe, expect, it } from "@alchemy.run/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { type Disk, simHost } from "./sim-host.ts";

class Added extends Domain.Event("Added", { n: Schema.Number }) {}
class Add extends Domain.Command("Add", {
  input: { id: Schema.String, n: Schema.Number },
  events: [Added],
  reply: { total: Schema.Number },
}) {}

/** A counter, as two deploys run it: the first adds each event twice, the second fixes that. */
const counter = (times: number) =>
  class Counter extends Domain.Aggregate("Counter", {
    id: Schema.String,
    state: Schema.Struct({ total: Schema.Number }),
    initial: { total: 0 },
    commands: [Add],
    keyOf: (command) => command.id,
    decide: { Add: (_, { n }) => [new Added({ n })] },
    evolve: { Added: (s, e) => ({ total: s.total + e.n * times }) },
    reply: { Add: (s) => ({ total: s.total }) },
  }) {};
const Buggy = counter(2);
const Fixed = counter(1);
class BuggyCounting extends Domain.Model("Counting", { aggregates: [Buggy] }) {}
class FixedCounting extends Domain.Model("Counting", { aggregates: [Fixed] }) {}

/** Each deploy on the same storage: one in-memory platform, or one disk of Durable Objects. */
const platforms = {
  "in memory": () => {
    const hosted = Memory.make();
    return () => hosted.layer;
  },
  "Durable Objects": () => {
    const disk: Disk = { objects: new Map() };
    return () =>
      DurableObjects.makePlatform(simHost({ rowsRead: 0 }, { disk }).host).pipe(
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      );
  },
} as const;

/** The stored events of a counter, as `[seq, n]`. */
const stored = (id: string) =>
  Effect.gen(function* () {
    const { aggregates } = yield* Internals;
    const events = yield* aggregates.get("Counter")!.events!(id);
    return events.map((row) => [row.envelope.seq, (row.event as { readonly n: number }).n]);
  });

for (const [name, platform] of Object.entries(platforms)) {
  describe(`Domain rebuild, ${name}`, { tags: ["unit", "local"] }, () => {
    it.live("folds a state a fixed evolve would have folded, and changes nothing else", () => {
      const storage = platform();
      return Effect.gen(function* () {
        // The first deploy folds each event twice.
        yield* Effect.gen(function* () {
          const counters = yield* Buggy;
          yield* counters.send(new Add({ id: "c-1", n: 1 }));
          const second = yield* counters.send(new Add({ id: "c-1", n: 2 }));
          expect(second.reply).toEqual({ total: 6 });
        }).pipe(
          Effect.scoped,
          Effect.provide(BuggyCounting.layer(Layer.empty).pipe(Layer.provideMerge(storage()))),
        );

        // The fix is deployed: the stored state stays wrong until it is rebuilt.
        yield* Effect.gen(function* () {
          const counters = yield* Fixed;
          expect(yield* counters.get("c-1")).toEqual({ total: 6 });
          const receipt = yield* counters.rebuild("c-1");
          expect(receipt).toEqual({ stream: "Counter/c-1", version: 2, changed: true });
          expect(yield* counters.get("c-1")).toEqual({ total: 3 });
          // Its events and version are as they were.
          expect(yield* stored("c-1")).toEqual([
            [1, 1],
            [2, 2],
          ]);
          // Rebuilt once, there is nothing left to change.
          expect(yield* counters.rebuild("c-1")).toMatchObject({ changed: false });
          // The next command decides from the rebuilt state.
          const next = yield* counters.send(new Add({ id: "c-1", n: 4 }));
          expect(next).toMatchObject({ version: 3, reply: { total: 7 } });
        }).pipe(
          Effect.scoped,
          Effect.provide(FixedCounting.layer(Layer.empty).pipe(Layer.provideMerge(storage()))),
        );
      });
    });

    it.live("leaves an instance with no events as it is", () => {
      const storage = platform();
      return Effect.gen(function* () {
        const counters = yield* Fixed;
        expect(yield* counters.rebuild("c-9")).toEqual({
          stream: "Counter/c-9",
          version: 0,
          changed: false,
        });
        expect(yield* counters.get("c-9")).toEqual({ total: 0 });
      }).pipe(
        Effect.scoped,
        Effect.provide(FixedCounting.layer(Layer.empty).pipe(Layer.provideMerge(storage()))),
      );
    });
  });
}
