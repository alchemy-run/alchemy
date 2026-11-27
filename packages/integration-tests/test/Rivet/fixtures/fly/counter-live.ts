/** The counter's implementation on the Fly pool. */
import * as Effect from "effect/Effect";
import { withClassSecret } from "../class-secret.ts";
import { Counter } from "../counter-declaration.ts";
import { CounterImpl } from "../counter-impl.ts";
import { Default } from "./cluster.ts";

export const CounterLive = Counter.make(
  { main: import.meta.url, handler: "CounterLive" },
  // Reads a secret as config: the nodes must get it without exposing it.
  withClassSecret(CounterImpl).pipe(Effect.provide(Default)),
);
