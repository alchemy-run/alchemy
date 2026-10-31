/** The counter's implementation on the AWS pool. */
import * as Effect from "effect/Effect";
import { CounterImpl } from "../counter-impl.ts";
import { Default } from "./cluster.ts";
import { Counter } from "./counter.ts";

export const CounterLive = Counter.make(
  { main: import.meta.url, handler: "CounterLive" },
  CounterImpl.pipe(Effect.provide(Default)),
);
