import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Default } from "../cluster.ts";
import { Journal } from "./journal.ts";

export default Journal.make(
  { main: import.meta.url, maxIdleTime: "10 minutes" },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<string>>([]);
      return Journal.of({
        Append: ({ payload }) => Ref.update(entries, (all) => [...all, payload.entry]),
        List: () => Ref.get(entries),
      });
    });
  }).pipe(Effect.provide(Default)),
);
