/** A model with a projection (failing through a fake) and a view, for the SPI tests. */
import * as Domain from "@alchemy.run/domain";
import { choose, fakeState, send, type Scenario } from "@alchemy.run/domain/Explore";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Go, Sink, Src, Start, T0, TwoSends, TwoSendsLive } from "./Models.ts";

/** A handler has no error channel: a failed write dies, and the host retries it. */
class RowStoreDown extends Data.TaggedError("RowStoreDown") {}

export class SrcRows extends Domain.Projection("SrcRows", { from: [Src], key: Src, on: [Go] }) {}

/** The row store is a fake: while `failsLeft` > 0 an apply may fail (choose ok | fail). */
export const SrcRowsLive = SrcRows.toLayer(
  Effect.gen(function* () {
    return Effect.fn(function* (batch) {
      const store = fakeState<{ rows: Record<string, number>; failsLeft: number }>("rows");
      if (store.failsLeft > 0 && choose("rows.apply", ["ok", "fail"]) === "fail") {
        store.failsLeft--;
        return yield* Effect.die(new RowStoreDown());
      }
      for (const input of batch as ReadonlyArray<any>)
        store.rows[input.source.id] = (store.rows[input.source.id] ?? 0) + 1;
    });
  }),
);

export class SrcCount extends Domain.View("SrcCount", {
  from: [Src],
  key: Src,
  state: Schema.Struct({ n: Schema.Number }),
  initial: { n: 0 },
  evolve: { Src: (s: { n: number }) => ({ n: s.n + 1 }) },
} as never) {}

export class SpiModel extends Domain.Model("SpiModel", {
  aggregates: [Src, Sink],
  policies: [TwoSends],
  projections: [SrcRows],
  views: [SrcCount],
}) {}

export const spiScenario = (o: {
  views?: "queued" | "inline" | "abstract";
  projection?: "queued" | "inline";
  fails?: number;
}): Scenario => ({
  name: `spi(${o.views ?? "queued"},${o.projection ?? "queued"},${o.fails ?? 0})`,
  model: SpiModel,
  layer: SpiModel.layer(Layer.mergeAll(TwoSendsLive, SrcRowsLive)),
  actors: ["s1", "s2"].map((id) => ({
    key: id,
    enabled: (s) => s.state("Src", id) === undefined,
    run: (ctx) => send(ctx, Src, id, new Start({}), { commandId: `api:${id}` }),
  })),
  fakes: [{ name: "rows", initial: () => ({ rows: {}, failsLeft: o.fails ?? 0 }) }],
  rules: [
    {
      id: "ROWS-MATCH",
      kind: "quiescent",
      check: (s) => {
        for (const [id] of s.instances("Src"))
          if (s.fake("rows").rows[id] !== 1) return `${id}: row count ${s.fake("rows").rows[id]}`;
        return undefined;
      },
    },
  ],
  bounds: { actorSteps: 2, depth: 20 },
  startTimeMillis: T0,
  host: {
    views: { SrcCount: o.views ?? "queued" },
    projections: { SrcRows: o.projection ?? "queued" },
    maxTries: 3,
    retryDefects: ["RowStoreDown"],
  },
});
