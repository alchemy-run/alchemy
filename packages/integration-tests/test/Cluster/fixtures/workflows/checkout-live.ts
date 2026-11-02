import * as Cluster from "@alchemy.run/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Checkout, Declined, Recorder } from "./workflows.ts";

export default Cluster.Workflow(
  Checkout,
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id, decline }) {
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
          ? record(id, "declined").pipe(Effect.andThen(new Declined({ reason: "card declined" })))
          : record(id, "charged").pipe(Effect.as("charged")),
      });
    });
  }),
).pipe(Layer.provide(Default));
