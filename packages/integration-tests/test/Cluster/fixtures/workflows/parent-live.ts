import * as Effect from "effect/Effect";
import { Activity } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Greet, Parent, Recorder } from "./workflows.ts";

export default Parent.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Parent.of(
      Effect.fn(function* ({ id }) {
        const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
        yield* Activity.make({ name: "parent", execute: record(id, `parent:${greeting}`) });
        return `parent got ${greeting}`;
      }),
    );
  }).pipe(Effect.provide(Default)),
);
