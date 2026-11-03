import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Journal } from "./journal.ts";

export const journalLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Journal.make(
    { main, maxIdleTime: "10 minutes" },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const entries = yield* Ref.make<ReadonlyArray<string>>([]);
        return Journal.of({
          Append: ({ payload }) => Ref.update(entries, (all) => [...all, payload.entry]),
          List: () => Ref.get(entries),
        });
      });
    }).pipe(Effect.provide(pool)),
  );
