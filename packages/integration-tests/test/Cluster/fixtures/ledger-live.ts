/** The ledger's implementation: unbounded concurrency, five idle seconds. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Clock from "effect/Clock";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Ledgers } from "./ledger.ts";

/** Instance builds per entity id, kept outside the instance so each build sees the last. */
const builds = new Map<string, number>();

export const ledgerLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Ledgers.make(
    { main, concurrency: "unbounded", maxIdleTime: "5 seconds" },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const { entityId } = yield* Entity.CurrentAddress;
        const builtAt = yield* Clock.currentTimeMillis;
        // Slow, so messages arrive while the instance is still being built.
        yield* Effect.sleep("200 millis");
        yield* Effect.sync(() => builds.set(entityId, (builds.get(entityId) ?? 0) + 1));
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
          Builds: () => Effect.sync(() => builds.get(entityId) ?? 0),
          BuiltAt: () => Effect.succeed(builtAt),
          Note: ({ payload }) => Effect.succeed(payload.text.length),
        });
      });
    }).pipe(Effect.provide(pool)),
  );
