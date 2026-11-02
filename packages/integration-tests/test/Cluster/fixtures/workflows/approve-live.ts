import * as Cluster from "@alchemy.run/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Activity, DurableDeferred } from "effect/workflow";
import { Default } from "../cluster.ts";
import { Approval, Approve, Recorder } from "./workflows.ts";

export default Cluster.Workflow(
  Approve,
  { main: import.meta.url },
  Effect.gen(function* () {
    const record = yield* Recorder;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "requested", execute: record(id, "requested") });
      const by = yield* DurableDeferred.await(Approval);
      yield* Activity.make({ name: "approved", execute: record(id, `approved:${by}`) });
      return `approved by ${by}`;
    });
  }),
).pipe(Layer.provide(Default));
