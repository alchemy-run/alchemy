/** The ledger's implementation: unbounded concurrency, five idle seconds. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Ledgers } from "./ledger.ts";

export const ledgerLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Ledgers.make(
    { main, concurrency: "unbounded", maxIdleTime: "5 seconds" },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const balance = yield* Ref.make(0);
        const memory = yield* Ref.make(0);
        return Ledgers.of({
          // Slow, so duplicates arrive while the first run is still going.
          Credit: ({ payload }) =>
            Effect.andThen(
              Effect.sleep("1 second"),
              Ref.updateAndGet(balance, (n) => n + payload.amount),
            ),
          Balance: () => Ref.get(balance),
          Remember: ({ payload }) => Ref.set(memory, payload.value),
          Recall: () => Ref.get(memory),
          Pin: () => Entity.keepAlive(true),
        });
      });
    }).pipe(Effect.provide(pool)),
  );
