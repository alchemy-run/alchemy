/** The conformance journal: one Rivet Durable Object per run. */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Journal } from "../../Workflows/conformance/journal.ts";
import { WorkflowPool } from "./workflow-cluster.ts";

export default class WorkflowJournal extends Rivet.DurableObject<WorkflowJournal>()(
  "WorkflowJournal",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      const entries = Effect.map(
        state.storage.get<ReadonlyArray<string>>("entries"),
        (entries) => entries ?? [],
      );
      return {
        append: (entry: string) =>
          state.storage.transaction(
            Effect.gen(function* () {
              yield* state.storage.put("entries", [...(yield* entries), entry]);
            }),
          ),
        list: () => entries,
      };
    });
  }).pipe(Effect.provide(WorkflowPool)),
) {}

// Calls fail while the pool's nodes start.
const inTransit = Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 });

/** The conformance journal over `WorkflowJournal`. */
export const JournalLive = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const journals = yield* WorkflowJournal;
    return {
      append: (id, entry) => journals.getByName(id).append(entry).pipe(inTransit, Effect.orDie),
      list: (id) => journals.getByName(id).list().pipe(inTransit, Effect.orDie),
    };
  }),
);
