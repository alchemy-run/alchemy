import * as Backfill from "@alchemy.run/domain/Backfill";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { Sim } from "./Backfill.sim.ts";

/**
 * What a backfill costs and how long it takes, measured in the simulator with
 * production tuning: Durable Object requests (calls and alarms), rows read and
 * written, and wall time in a model where a call's round trip is 10ms, an alarm
 * fires 50ms after it is set, and an object spends 1ms per event and runs one
 * event at a time. Each run prints a `BENCH` line of JSON.
 */

type Shape = "keyed" | "own" | "hot" | "fan";

/**
 * Which key an instance's events go to: the key named after it (a view keyed by
 * its aggregate, no `keyOf`), its own key through `keyOf`, one shared by all,
 * or one per 100 instances.
 */
const keyFor = (shape: Shape, instance: number, instances: number) =>
  shape === "keyed"
    ? `s${instance}`
    : shape === "own"
      ? `k${instance}`
      : shape === "hot"
        ? "all"
        : `k${instance % Math.max(1, Math.floor(instances / 100))}`;

const bench = (
  shape: Shape,
  instances: number,
  events: number,
  limits: Backfill.Limits = Backfill.defaultLimits,
) =>
  Effect.gen(function* () {
    const sim = new Sim(1, "view:V#1", undefined, limits);
    sim.singleSource = shape === "keyed";
    sim.timed = true;
    // History before the consumer exists, spread over time.
    for (let e = 0; e < events; e++) {
      for (let i = 0; i < instances; i++) {
        sim.now += 1;
        yield* sim.commit(`A/s${i}`, [keyFor(shape, i, instances)]);
      }
    }
    // Leaves that filled while the history was written split before the deploy.
    yield* sim.run();
    sim.resetMeasures();
    const started = performance.now();
    yield* sim.deploy();
    yield* sim.run([], { maxSteps: 50_000_000 });
    const totals = sim.totals();
    expect((yield* sim.status()).complete).toContain("view:V#1");
    const result = {
      shape,
      instances,
      events: instances * events,
      keys: sim.keys.size,
      requests: totals.total.requests,
      rowsRead: totals.total.rowsRead,
      rowsWritten: totals.total.rowsWritten,
      requestsPerEvent: +(totals.total.requests / (instances * events)).toFixed(2),
      writesPerEvent: +(totals.total.rowsWritten / (instances * events)).toFixed(2),
      readsPerEvent: +(totals.total.rowsRead / (instances * events)).toFixed(2),
      hottestObjectRequests: Math.max(
        totals.nodes.hottest,
        totals.sources.hottest,
        totals.keys.hottest,
      ),
      directoryNodes: totals.directory.nodes,
      directoryDepth: totals.directory.depth,
      wallSeconds: +(sim.makespan / 1000).toFixed(1),
      simulatedIn: `${Math.round(performance.now() - started)}ms`,
    };
    yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(result)}`));
    return result;
  });

describe("Domain backfill benchmarks (simulated)", () => {
  it.effect.skipIf(!!process.env.FAST)(
    "keyed by its aggregate: cost per event is flat, wall time does not grow with width",
    () =>
      Effect.gen(function* () {
        const runs = [];
        for (const instances of [100, 1_000, 10_000])
          runs.push(yield* bench("keyed", instances, 10));
        const [small, , large] = runs;
        expect(large!.requestsPerEvent).toBeLessThan(small!.requestsPerEvent * 1.5);
        expect(large!.wallSeconds).toBeLessThan(small!.wallSeconds * 2);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "one key per instance: cost per event is flat, wall time does not grow with width",
    () =>
      Effect.gen(function* () {
        const runs = [];
        for (const instances of [100, 1_000, 10_000]) runs.push(yield* bench("own", instances, 10));
        // Cost grows with the events; wall time stays within a few alarm hops.
        const [small, , large] = runs;
        expect(large!.requestsPerEvent).toBeLessThan(small!.requestsPerEvent * 1.5);
        expect(large!.wallSeconds).toBeLessThan(small!.wallSeconds * 3);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "cost per instance and per event: longer histories at the same width",
    () =>
      Effect.gen(function* () {
        for (const shape of ["keyed", "own"] as const)
          for (const events of [1, 10, 100]) yield* bench(shape, 1_000, events);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "a hundred instances per key",
    () =>
      Effect.gen(function* () {
        for (const instances of [1_000, 10_000]) yield* bench("fan", instances, 10);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "one hot key fed by every instance: wall time grows with that key's history",
    () =>
      Effect.gen(function* () {
        for (const instances of [100, 1_000]) yield* bench("hot", instances, 10);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "one key's history grows: wall time grows with its depth, not before a few thousand events",
    () =>
      Effect.gen(function* () {
        const one = [];
        for (const events of [10, 100, 1_000, 10_000]) one.push(yield* bench("keyed", 1, events));
        expect(one[2]!.wallSeconds).toBeLessThan(one[0]!.wallSeconds * 1.5);
        for (const events of [10, 100, 1_000]) yield* bench("hot", 100, events);
      }),
    { timeout: 600_000 },
  );

  it.effect.skipIf(!!process.env.FAST)(
    "a tree of small leaves grows as log16 of the instances",
    () =>
      Effect.gen(function* () {
        // Leaves of 16 from depth 1: the shape of a tree of leaves of 256 from depth 4,
        // at a scale the simulator can run.
        const limits: Backfill.Limits = { ...Backfill.defaultLimits, leafSize: 16, depth: 1 };
        const runs = [];
        for (const instances of [256, 2_048, 16_384])
          runs.push(yield* bench("own", instances, 1, limits));
        expect(runs[2]!.directoryDepth).toBeGreaterThan(runs[0]!.directoryDepth);
      }),
    { timeout: 900_000 },
  );
});
