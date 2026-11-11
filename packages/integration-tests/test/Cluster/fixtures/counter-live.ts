/** The counter's implementation, deployed to the default pool with its middleware. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { AuthLive, CurrentUser } from "./auth.ts";
import { CounterBoom, Counters } from "./counter.ts";

export const counterLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Counters.make(
    { main },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const { entityId } = yield* Entity.CurrentAddress;
        const count = yield* Ref.make(0);
        return Counters.of({
          Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
          Get: () => Ref.get(count),
          Add: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
          Boom: () => Effect.fail(new CounterBoom({ reason: "expected" })),
          Tick: ({ payload }) => Stream.range(1, payload.n),
          Whoami: () => Effect.succeed(entityId),
          Secret: () =>
            Effect.gen(function* () {
              const user = yield* CurrentUser;
              return `${entityId} belongs to ${user.id}`;
            }),
        });
      });
    }).pipe(Effect.provide(pool.pipe(Layer.provide(AuthLive)))),
  );
