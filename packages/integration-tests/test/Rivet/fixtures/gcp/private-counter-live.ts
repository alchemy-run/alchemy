/** The counter on a Cloud Run worker pool that reaches its control plane privately. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter } from "../counter-declaration.ts";
import { CounterImpl } from "../counter-impl.ts";
import { PrivateCluster, PrivatePool } from "./private-cluster.ts";

export const PrivateCounterLive = Counter.make(
  { main: import.meta.url, handler: "PrivateCounterLive" },
  CounterImpl.pipe(Effect.provide(PrivatePool.pipe(Layer.provide(PrivateCluster)))),
);
