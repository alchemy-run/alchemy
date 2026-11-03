import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Checkout, Declined, Recorder } from "./workflows.ts";

export const checkoutLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Checkout.make(
    { main },
    Effect.gen(function* () {
      const record = yield* Recorder;
      return Checkout.of(
        Effect.fn(function* ({ id, decline }) {
          yield* Activity.make({ name: "reserve", execute: record(id, "reserve") }).pipe(
            Checkout.withCompensation(() =>
              Activity.make({ name: "release", execute: record(id, "release") }),
            ),
          );
          return yield* Activity.make({
            name: "charge",
            success: Schema.String,
            error: Declined,
            execute: decline
              ? record(id, "declined").pipe(
                  Effect.andThen(new Declined({ reason: "card declined" })),
                )
              : record(id, "charged").pipe(Effect.as("charged")),
          });
        }),
      );
    }).pipe(Effect.provide(pool)),
  );
