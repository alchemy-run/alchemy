/** The conformance counter on the local Docker pool. */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";
import { CounterImpl } from "./counter-impl.ts";

export default class Counter extends Rivet.DurableObject<Counter>()(
  "Counter",
  { main: import.meta.url },
  CounterImpl.pipe(Effect.provide(Default)),
) {}
