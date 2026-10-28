import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { type Faults, noFaults, Sim } from "./Backfill.sim.ts";

const TARGET = "view:V";

/**
 * Check what a finished simulation must hold:
 * - every key received exactly the events routed to it, once each, in seq order per source;
 * - what a key applied while backfilling is in timestamp order, `(at, stream, seq)`;
 * - every source routes the target live again, and no backfill state is left behind;
 * - the root reports the target complete.
 */
const verify = (sim: Sim) =>
  Effect.gen(function* () {
    const expected = new Map<string, Array<string>>();
    for (const source of sim.sources.values()) {
      const stream = `${source.ref.source}/${source.ref.id}`;
      for (const event of source.events) {
        for (const key of event.keys) {
          const list = expected.get(key) ?? [];
          list.push(`${stream}#${event.seq}`);
          expected.set(key, list);
        }
      }
    }
    for (const [key, events] of expected) {
      const applied = sim.keys.get(key)?.applied ?? [];
      const ids = applied.map(({ delivery }) => `${delivery.source}#${delivery.seq}`);
      // Exactly once each.
      expect([...ids].sort()).toEqual([...events].sort());
      // In seq order per source.
      const last = new Map<string, number>();
      for (const { delivery } of applied) {
        expect(delivery.seq).toBeGreaterThan(last.get(delivery.source) ?? 0);
        last.set(delivery.source, delivery.seq);
      }
      // Everything the merge pulled is applied in timestamp order. Live deliveries
      // keep their source's order, but may arrive after a later one was applied.
      const backfilled = applied
        .filter(({ backfilling, delivery }) => backfilling && delivery.history)
        .map(({ delivery }) => delivery);
      const order = (d: (typeof backfilled)[number]) =>
        [String(d.envelope.at).padStart(15, "0"), d.source, String(d.seq).padStart(12, "0")].join(
          ":",
        );
      expect(backfilled.map(order)).toEqual([...backfilled.map(order)].sort());
    }
    for (const source of sim.sources.values()) {
      expect(
        (source.object.data.get("routed") as Record<string, number> | undefined)?.[TARGET],
      ).toBe(source.events.length);
      expect(
        [...source.object.data.keys()].filter(
          (key) => key.startsWith("bf:") && !key.startsWith("bf:q-"),
        ),
      ).toEqual([]);
    }
    for (const key of sim.keys.values()) {
      expect(
        [...key.object.data.keys()].filter(
          (row) => row.startsWith("bf:") && !row.startsWith("bf:done:"),
        ),
      ).toEqual([]);
    }
    expect((yield* sim.status()).complete).toContain(TARGET);
  });

/** Commit `count` events on `sources` instances, each routed to one of `keys` keys. */
const history = (sim: Sim, sources: number, count: number, keys: number, prefix = "s") =>
  Array.from({ length: count }, (_, i) => () => {
    sim.now += 1;
    return sim.commit(`A/${prefix}${i % sources}`, [`k${(i * 7) % keys}`]);
  });

const scenario = (
  name: string,
  run: (sim: Sim) => Effect.Effect<void>,
  options: { readonly faults?: Faults; readonly seeds?: number } = {},
) =>
  it.effect(name, () =>
    Effect.forEach(
      Array.from({ length: options.seeds ?? 20 }, (_, seed) => seed + 1),
      (seed) =>
        Effect.gen(function* () {
          const sim = new Sim(seed, TARGET, options.faults ?? noFaults);
          yield* run(sim);
          yield* verify(sim);
        }).pipe(Effect.annotateLogs({ seed })),
      { discard: true },
    ),
  );

/** History recorded before the consumer existed, then a deploy, then the backfill. */
const backfill = (sim: Sim, sources: number, events: number, keys: number) =>
  Effect.gen(function* () {
    for (const commit of history(sim, sources, events, keys)) yield* commit();
    yield* sim.deploy();
    yield* sim.run();
  });

describe("Domain backfill (simulated)", () => {
  scenario("a consumer with no history completes", (sim) =>
    Effect.gen(function* () {
      yield* sim.deploy();
      yield* sim.run();
    }),
  );

  scenario("one source, one key", (sim) => backfill(sim, 1, 12, 1));

  scenario("many sources and keys, applied in timestamp order", (sim) => backfill(sim, 9, 60, 5));

  scenario("a hot key fed by every source", (sim) => backfill(sim, 25, 80, 1));

  scenario("an event routed to several keys", (sim) =>
    Effect.gen(function* () {
      for (let i = 0; i < 30; i++) {
        sim.now += 1;
        yield* sim.commit(`A/s${i % 4}`, [`k${i % 3}`, `k${(i + 1) % 3}`]);
      }
      yield* sim.deploy();
      yield* sim.run();
    }),
  );

  scenario("commits during the backfill: to scanned sources, new keys, and new instances", (sim) =>
    Effect.gen(function* () {
      for (const commit of history(sim, 6, 40, 4)) yield* commit();
      yield* sim.deploy();
      yield* sim.run([...history(sim, 6, 20, 6, "s"), ...history(sim, 3, 9, 4, "new")]);
    }),
  );

  scenario("instances still on older code catch up once they run the deployed code", (sim) =>
    Effect.gen(function* () {
      for (let i = 0; i < 20; i++) {
        sim.now += 1;
        // Every third instance keeps running code without the target for a while.
        yield* sim.commit(`A/s${i % 6}`, [`k${i % 3}`], i % 3 === 0 ? sim.now + 120_000 : 0);
      }
      yield* sim.deploy();
      yield* sim.run();
    }),
  );

  scenario("news that arrives twice, from several nodes, starts one sweep", (sim) =>
    Effect.gen(function* () {
      for (const commit of history(sim, 5, 20, 3)) yield* commit();
      yield* sim.deploy();
      yield* sim.retry(sim.net.node.news("3f", [TARGET]));
      yield* sim.retry(sim.net.node.news("", [TARGET]));
      yield* sim.run();
    }),
  );

  scenario(
    "calls that fail in transit, before or after they run",
    (sim) => backfill(sim, 8, 50, 4),
    { faults: { callBefore: 0.1, callAfter: 0.1, crash: 0 } },
  );

  scenario("objects that crash before committing a step", (sim) => backfill(sim, 8, 50, 4), {
    faults: { callBefore: 0, callAfter: 0, crash: 0.1 },
  });

  scenario(
    "every fault at once, with commits during the backfill",
    (sim) =>
      Effect.gen(function* () {
        for (const commit of history(sim, 7, 40, 4)) yield* commit();
        yield* sim.deploy();
        yield* sim.run([...history(sim, 7, 25, 5), ...history(sim, 3, 10, 4, "new")]);
      }),
    { faults: { callBefore: 0.08, callAfter: 0.08, crash: 0.08 }, seeds: 40 },
  );

  scenario(
    "an instance created on older code after the backfill completed is caught up by its leaf",
    (sim) =>
      Effect.gen(function* () {
        for (const commit of history(sim, 4, 16, 3)) yield* commit();
        yield* sim.deploy();
        yield* sim.run();
        // A host still on the code from before the deploy creates an instance, then
        // moves to the deployed code; its history reaches keys that already finished.
        sim.now += 1;
        yield* sim.commit("A/late", ["k0"], sim.now + 60_000);
        sim.now += 1;
        yield* sim.commit("A/late", ["k1"]);
        yield* sim.run([
          () => {
            sim.now += 61_000;
            return sim.commit("A/late", ["k0"]);
          },
        ]);
      }),
  );

  scenario(
    "older code and faults together",
    (sim) =>
      Effect.gen(function* () {
        for (let i = 0; i < 30; i++) {
          sim.now += 1;
          yield* sim.commit(`A/s${i % 6}`, [`k${i % 4}`], i % 4 === 0 ? sim.now + 90_000 : 0);
        }
        yield* sim.deploy();
        yield* sim.run(history(sim, 6, 12, 5));
      }),
    { faults: { callBefore: 0.05, callAfter: 0.05, crash: 0.05 }, seeds: 30 },
  );

  scenario(
    "stress: every fault, many seeds",
    (sim) =>
      Effect.gen(function* () {
        for (const commit of history(sim, 10, 50, 6)) yield* commit();
        yield* sim.deploy();
        yield* sim.run([...history(sim, 10, 20, 8), ...history(sim, 4, 8, 6, "new")]);
      }),
    { faults: { callBefore: 0.1, callAfter: 0.1, crash: 0.1 }, seeds: 300 },
  );
});
