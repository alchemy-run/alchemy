/** The counter's implementation, deployed to the default pool with its middleware. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Clock from "effect/Clock";
import { Entity } from "effect/cluster";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Rpc } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AuthLive, CurrentUser } from "./auth.ts";
import { CounterBoom, Counters } from "./counter.ts";

/** Runs of `Flaky` per entity id, kept outside the instance so a restart sees them. */
const flakyRuns = new Map<string, number>();

export const counterLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Counters.make(
    { main },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const { entityId } = yield* Entity.CurrentAddress;
        const count = yield* Ref.make(0);
        const release = yield* Ref.make(yield* Deferred.make<void>());
        const interrupted = yield* Ref.make(false);
        const settled = yield* Ref.make(false);
        const marked = yield* Ref.make(false);
        const countdowns = yield* Ref.make(0);
        const ranAt = yield* Ref.make(0);
        return Counters.of({
          Increment: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
          Get: () => Ref.get(count),
          Add: ({ payload }) => Ref.updateAndGet(count, (n) => n + payload.amount),
          AddLater: ({ payload }) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Ref.set(ranAt, now)),
              Effect.andThen(Ref.updateAndGet(count, (n) => n + payload.amount)),
            ),
          Boom: () => Effect.fail(new CounterBoom({ reason: "expected" })),
          Tick: ({ payload }) => Stream.range(1, payload.n),
          Whoami: () => Effect.succeed(entityId),
          Secret: () =>
            Effect.gen(function* () {
              const user = yield* CurrentUser;
              return `${entityId} belongs to ${user.id}`;
            }),
          Flaky: () =>
            Effect.suspend(() => {
              const runs = (flakyRuns.get(entityId) ?? 0) + 1;
              flakyRuns.set(entityId, runs);
              return runs === 1 ? Effect.die(new Error("flaky")) : Ref.get(count);
            }),
          Wait: () =>
            Effect.gen(function* () {
              const released = yield* Deferred.make<void>();
              yield* Ref.set(release, released);
              const result = yield* Deferred.await(released).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              return Option.isSome(result) ? "released" : "timed out";
            }),
          Release: () =>
            Rpc.fork(
              Effect.flatMap(Ref.get(release), (released) =>
                Effect.asVoid(Deferred.succeed(released, undefined)),
              ),
            ),
          Hang: () => Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
          WasInterrupted: () => Ref.get(interrupted),
          Settle: () =>
            Rpc.uninterruptible(
              Effect.sleep("2 seconds").pipe(
                Effect.andThen(Ref.set(settled, true)),
                Effect.as("settled"),
              ),
            ),
          Settled: () => Ref.get(settled),
          Mark: () => Ref.set(marked, true),
          Marked: () => Ref.get(marked),
          Countdown: ({ payload }) =>
            Stream.unwrap(
              Effect.as(
                Ref.update(countdowns, (n) => n + 1),
                Stream.range(1, payload.n).pipe(
                  Stream.schedule(Schedule.spaced(payload.everyMillis)),
                ),
              ),
            ),
          CountdownRuns: () => Ref.get(countdowns),
          RanAt: () => Ref.get(ranAt),
        });
      });
    }).pipe(Effect.provide(pool.pipe(Layer.provide(AuthLive)))),
  );
