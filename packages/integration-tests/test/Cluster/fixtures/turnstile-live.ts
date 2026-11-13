/** The turnstile's implementation: one message at a time, two in its mailbox. */
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Turnstiles } from "./turnstile.ts";

export const turnstileLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Turnstiles.make(
    { main, mailboxCapacity: 2 },
    Effect.gen(function* () {
      return Effect.gen(function* () {
        const passed = yield* Ref.make(0);
        const pass = Effect.andThen(
          Effect.sleep("1500 millis"),
          Ref.updateAndGet(passed, (n) => n + 1),
        );
        return Turnstiles.of({
          Pass: () => pass,
          PassOnce: () => pass,
          Passed: () => Ref.get(passed),
        });
      });
    }).pipe(Effect.provide(pool)),
  );
