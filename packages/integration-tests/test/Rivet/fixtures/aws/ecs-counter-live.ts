/** The counter's implementation on the EC2 pool of an ECS control plane. */
import * as Effect from "effect/Effect";
import { CounterImpl } from "../counter-impl.ts";
import { Counter } from "./counter.ts";
import { Default } from "./ecs-cluster.ts";

export const CounterLive = Counter.make(
  { main: import.meta.url, handler: "CounterLive" },
  CounterImpl.pipe(Effect.provide(Default)),
);
