/**
 * The exposed ingress worker's deploy module: the engine's guard gateway
 * published through a public ALB (`expose: "public"`), so the test can
 * drive the actor gateway protocol directly over the internet — no Lambda
 * indirection.
 */
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../../counter.ts";
import { IngressActors, IngressWorker } from "./cluster.ts";

export default IngressWorker.make(
  { cluster: IngressActors, main: import.meta.url, expose: "public" },
  Effect.gen(function* () {
    // Registers the Durable Object on the worker; the runner serves it
    // as a Rivet actor.
    yield* Counter;
    return {};
  }).pipe(Effect.provide(CounterLive)),
);
