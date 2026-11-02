import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Greet, Recorder } from "./workflows.ts";

export default Greet.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Greet.of(
      Effect.fn(function* ({ id, name }) {
        const greeting = yield* Activity.make({
          name: "greet",
          success: Schema.String,
          execute: record(id, "greet").pipe(Effect.as(`hello ${name}`)),
        });
        yield* Activity.make({ name: "log", execute: record(id, "log") });
        return greeting;
      }),
    );
  }).pipe(Effect.provide(Default)),
);
