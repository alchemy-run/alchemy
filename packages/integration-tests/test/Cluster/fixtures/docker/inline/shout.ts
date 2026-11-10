/** A workflow declared inline: the class callers `yield*` is its implementation. */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Default } from "../cluster.ts";

export default class Shout extends Cluster.Workflow<Shout>()(
  "Shout",
  {
    payload: { text: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ text }) => text,
  },
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.fn(function* ({ text }) {
      return yield* Activity.make({
        name: "shout",
        success: Schema.String,
        execute: Effect.succeed(text.toUpperCase()),
      });
    });
  }).pipe(Effect.provide(Default)),
) {}
