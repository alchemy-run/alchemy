import * as Cluster from "@alchemy.run/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Activity } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Greet, Parent, Recorder } from "./workflows.ts";

export default Cluster.Workflow(
  Parent,
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id }) {
      const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
      yield* Activity.make({ name: "parent", execute: record(id, `parent:${greeting}`) });
      return `parent got ${greeting}`;
    });
  }),
).pipe(Layer.provide(Default));
