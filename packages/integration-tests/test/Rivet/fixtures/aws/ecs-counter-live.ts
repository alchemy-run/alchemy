/** The counter's implementation on the EC2 pool of an ECS control plane. */
import * as Effect from "effect/Effect";
import { Counter } from "../counter-declaration.ts";
import { CounterImpl } from "../counter-impl.ts";
import { Default } from "./ecs-cluster.ts";

export const CounterLive = Counter.make(
  { main: import.meta.url, handler: "CounterLive" },
  CounterImpl.pipe(Effect.provide(Default)),
);
