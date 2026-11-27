/** The waiters' implementation, one per pool. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { EdgeWaiters, PrivateWaiters, SecureWaiters } from "./waiter.ts";

type Waiters = typeof PrivateWaiters | typeof EdgeWaiters | typeof SecureWaiters;

export const waiterLive = <R>(Waiters: Waiters, main: string, pool: Cluster.PoolLayer<R>) =>
  (Waiters as typeof PrivateWaiters).make(
    { main },
    Effect.succeed(
      Effect.succeed(
        PrivateWaiters.of({
          Sleep: ({ payload }) =>
            Effect.sleep(`${payload.seconds} seconds`).pipe(Effect.as(payload.seconds)),
          Drip: ({ payload }) =>
            Stream.range(1, payload.count).pipe(
              Stream.schedule(Schedule.spaced(`${payload.gapSeconds} seconds`)),
            ),
        }),
      ),
    ).pipe(Effect.provide(pool)),
  );
