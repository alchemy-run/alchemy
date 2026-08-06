import * as Effect from "effect/Effect";
import { Cells } from "./cells.ts";
import { CounterLive, Counter } from "./counter.ts";

/** The deployable fleet module: hosts the Counter implementation. */
export default Cells.make(
  { main: import.meta.url, instances: 1 },
  Effect.gen(function* () {
    yield* Counter;
    return {};
  }).pipe(Effect.provide(CounterLive)),
);
